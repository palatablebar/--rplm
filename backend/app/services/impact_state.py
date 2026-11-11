"""影响分析输入状态指纹与覆盖缺口识别。

缓存正确性的关键：一次影响分析的结果只取决于三类输入——
1. 列级血缘边（当前真实的 source → target 传播关系）；
2. 转换的解析状态（parse_status / SQL 版本 / updated_at，决定边是否可信、是否有未展开部分）；
3. 资产列清单（columns_json，决定 SELECT * 能否展开、缺列缺口）。

把这三类输入规范化后做 sha256，得到 state_hash：
- 同一分析目标 + 同一 state_hash 的历史报告可以安全复用（同口径，不新增报告）；
- 上游字段变更、补列、重解析使输入变化时 state_hash 必然改变，触发重算；
- 历史报告永不改写，旧报告保留在 impact_analyses 中供追溯。

本模块只依赖 ORM 模型与标准库，backend 与 worker 共用同一份实现。
"""
from __future__ import annotations

import hashlib
import json

from sqlalchemy.orm import Session

from app.models.data_asset import DataAsset
from app.models.lineage_edge import LineageEdge
from app.models.transformation import Transformation

# 列清单不完整 / 解析未完成，导致血缘无法继续追踪的缺口类型
GAP_STAR_INCOMPLETE = "star_incomplete_columns"
GAP_PARSE_FAILED = "parse_failed"
GAP_PARSE_PENDING = "parse_pending"
GAP_PARSE_OTHER = "parse_partial_other"
GAP_UNKNOWN_INPUT = "unknown_input_asset"

_IN_SCOPE_GAP_REASONS = {GAP_STAR_INCOMPLETE, GAP_PARSE_FAILED, GAP_PARSE_PENDING, GAP_PARSE_OTHER}


def _stable_json(payload: object) -> str:
    """sort_keys 保证同内容同字节，避免 dict 顺序造成指纹抖动。"""
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _edge_state(edges: list[LineageEdge]) -> list[dict]:
    return sorted(
        (
            {
                "transformation_id": str(edge.transformation_id),
                "source_asset_id": str(edge.source_asset_id),
                "source_column": edge.source_column,
                "target_asset_id": str(edge.target_asset_id),
                "target_column": edge.target_column,
                "edge_kind": edge.edge_kind,
                "expression_text": edge.expression_text,
            }
            for edge in edges
        ),
        key=lambda item: (
            item["source_asset_id"],
            item["source_column"],
            item["target_asset_id"],
            item["target_column"],
            item["transformation_id"],
        ),
    )


def _transformation_state(transformations: list[Transformation]) -> list[dict]:
    """转换指纹：SQL 文本、解析状态、版本与更新时间。

    只放会影响血缘边/缺口判定的字段，owner、dialect 之外的展示字段不参与。
    """
    return sorted(
        (
            {
                "id": str(t.id),
                "name": t.name,
                "dialect": t.dialect,
                "sql_sha256": hashlib.sha256((t.sql_text or "").encode("utf-8")).hexdigest(),
                "parse_status": t.parse_status,
                "parse_error": t.parse_error,
                "version": t.version,
                "updated_at": t.updated_at.isoformat() if t.updated_at else None,
                "report_unresolved": (t.report_json or {}).get("unresolved", []),
            }
            for t in transformations
        ),
        key=lambda item: item["id"],
    )


def _asset_state(assets: list[DataAsset]) -> list[dict]:
    return sorted(
        (
            {
                "id": str(a.id),
                "asset_type": a.asset_type,
                "status": a.status,
                "columns": [
                    {
                        "name": (c or {}).get("name"),
                        "data_type": (c or {}).get("data_type"),
                        "nullable": (c or {}).get("nullable"),
                        "ordinal": (c or {}).get("ordinal"),
                    }
                    for c in (a.columns_json or [])
                ],
            }
            for a in assets
        ),
        key=lambda item: item["id"],
    )


def build_impact_state(
    db: Session,
    *,
    target_asset_id,
    target_column: str | None,
    change_type: str,
) -> dict:
    """汇总一次分析的全部输入，返回 {state_hash, edges, transformations, assets}。

    指纹覆盖全量边/转换/资产，而不只是可达子图：这样任何一次补列或重解析都会让
    state_hash 变化，避免"漏掉新出现的下游"。代价是一次全表扫描，资产规模在演示
    与中小数仓下可接受，且本函数只在发起分析时执行。
    """
    edges = db.query(LineageEdge).all()
    transformations = db.query(Transformation).all()
    assets = db.query(DataAsset).all()

    payload = {
        "target": {
            "asset_id": str(target_asset_id),
            "column": target_column,
            "change_type": change_type,
        },
        "edges": _edge_state(edges),
        "transformations": _transformation_state(transformations),
        "assets": _asset_state(assets),
    }
    state_hash = hashlib.sha256(_stable_json(payload).encode("utf-8")).hexdigest()
    return {
        "state_hash": state_hash,
        "edges": edges,
        "transformations": transformations,
        "assets": assets,
    }


def _gap_id(kind: str, transformation_id: str, asset_id: str | None, column: str | None) -> str:
    raw = "|".join([kind, transformation_id, asset_id or "", column or ""])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def collect_coverage_gaps(
    *,
    transformations: list[Transformation],
    assets_by_id: dict[str, DataAsset],
    reachable_asset_ids: set[str],
) -> dict:
    """识别"血缘无法继续追踪"的覆盖缺口。

    两类来源：
    1. partial/failed/pending 转换自身（解析没走完，下游边不完整或缺失）；
    2. 转换报告 unresolved 中记录的 SELECT * 缺列 / 未知输入资产（列清单不完整）。

    in_scope=True 表示缺口位于本次 BFS 可达集合（含起点资产）的边界上：缺口转换的
    输入或输出资产落在可达集合内，迁移清单可能因此漏项；in_scope=False 是全局存在
    但与本次传播无关的缺口，仍列出以声明分析边界。
    任何缺口存在时 checklist_complete=False，报告不得被当作完整迁移清单。
    """
    gaps: list[dict] = []
    seen: set[tuple] = set()

    def add_gap(
        kind: str,
        *,
        transformation: Transformation,
        asset_id: str | None,
        asset_name: str | None,
        column: str | None,
        missing: list[str],
        detail: str,
        uncertain_assets: list[str],
    ) -> None:
        touched_ids = {str(transformation.output_asset_id), *(transformation.input_asset_ids_json or [])}
        if asset_id:
            touched_ids.add(str(asset_id))
        in_scope = bool(touched_ids & reachable_asset_ids)
        key = (kind, str(transformation.id), asset_id, column, tuple(missing))
        if key in seen:
            return
        seen.add(key)
        gaps.append(
            {
                "gap_id": _gap_id(kind, str(transformation.id), asset_id, column),
                "kind": kind,
                "in_scope": in_scope,
                "transformation_id": str(transformation.id),
                "transformation_name": transformation.name,
                "parse_status": transformation.parse_status,
                "asset_id": asset_id,
                "asset_name": asset_name,
                "column": column,
                "missing_columns": missing,
                "detail": detail,
                "uncertain_assets": sorted(a for a in uncertain_assets if a),
            }
        )

    for transformation in transformations:
        report = transformation.report_json or {}
        unresolved = report.get("unresolved") or []
        output_asset = assets_by_id.get(str(transformation.output_asset_id))
        output_name = output_asset.display_name if output_asset else str(transformation.output_asset_id)

        if transformation.parse_status == "failed":
            add_gap(
                GAP_PARSE_FAILED,
                transformation=transformation,
                asset_id=str(transformation.output_asset_id),
                asset_name=output_name,
                column=None,
                missing=[],
                detail=(
                    f"转换 {transformation.name} 解析失败（{transformation.parse_error or '无错误信息'}），"
                    "未产出任何血缘边，其下游影响无法追踪"
                ),
                uncertain_assets=[output_name],
            )
            continue
        if transformation.parse_status == "pending":
            add_gap(
                GAP_PARSE_PENDING,
                transformation=transformation,
                asset_id=str(transformation.output_asset_id),
                asset_name=output_name,
                column=None,
                missing=[],
                detail=f"转换 {transformation.name} 尚未解析，血缘边缺失，其下游影响无法追踪",
                uncertain_assets=[output_name],
            )
            continue

        for issue in unresolved:
            reason = issue.get("reason") or ""
            issue_asset_id = issue.get("asset_id")
            issue_asset = assets_by_id.get(str(issue_asset_id)) if issue_asset_id else None
            issue_asset_name = (
                issue_asset.display_name if issue_asset else issue.get("asset_name")
            )
            missing = list(issue.get("missing") or [])
            if reason == "unknown_input_asset":
                add_gap(
                    GAP_UNKNOWN_INPUT,
                    transformation=transformation,
                    asset_id=issue_asset_id,
                    asset_name=issue_asset_name,
                    column=issue.get("column"),
                    missing=missing,
                    detail=(
                        f"转换 {transformation.name} 引用了未登记的输入资产"
                        f"（{issue.get('detail') or issue_asset_name or '未知表'}），该分支无法溯源"
                    ),
                    uncertain_assets=[output_name, issue_asset_name or ""],
                )
                continue
            if reason in {"star_unexpanded", "star_unresolved_table"} or issue.get("column") == "*":
                add_gap(
                    GAP_STAR_INCOMPLETE,
                    transformation=transformation,
                    asset_id=issue_asset_id,
                    asset_name=issue_asset_name,
                    column="*",
                    missing=missing or ["*"],
                    detail=(
                        issue.get("detail")
                        or f"转换 {transformation.name} 的 SELECT * 因列清单不完整无法全部展开，"
                        "未登记列的下游传播无法追踪"
                    ),
                    uncertain_assets=[output_name, issue_asset_name or ""],
                )
                continue
            # 其它 partial 原因（union_not_supported / ambiguous_column / empty_projection 等）
            add_gap(
                GAP_PARSE_OTHER,
                transformation=transformation,
                asset_id=issue_asset_id or str(transformation.output_asset_id),
                asset_name=issue_asset_name or output_name,
                column=issue.get("column"),
                missing=missing,
                detail=issue.get("detail")
                or f"转换 {transformation.name} 存在未完全解析的片段（{reason}），对应血缘不完整",
                uncertain_assets=[output_name],
            )

    in_scope_gaps = [gap for gap in gaps if gap["in_scope"]]
    coverage = {
        "checklist_complete": len(gaps) == 0,
        "in_scope_gap_count": len(in_scope_gaps),
        "total_gap_count": len(gaps),
        "in_scope": in_scope_gaps,
        "other_gaps": [gap for gap in gaps if not gap["in_scope"]],
        "gap_reasons": sorted({gap["kind"] for gap in gaps}),
        "uncertain_scope": sorted(
            {name for gap in gaps for name in gap["uncertain_assets"] if gap["in_scope"]}
        ),
        "disclaimer": (
            "存在因列清单不完整或转换未成功解析而无法追踪的下游，migration_checklist 不是完整迁移清单，"
            "缺口与不确定范围见 coverage；补全列清单并重新解析后需重新发起分析。"
            if gaps
            else "全部相关转换解析成功且列清单完整，迁移清单覆盖当前血缘可达的全部下游。"
        ),
    }
    return coverage
