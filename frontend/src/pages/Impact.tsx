import { useEffect, useMemo, useState } from 'react';
import { assetsApi } from '../api/assets';
import { impactApi } from '../api/impact';
import { ColumnTag } from '../components/common/ColumnTag';
import { CycleWarning } from '../components/common/CycleWarning';
import { ErrorPanel } from '../components/common/ErrorPanel';
import { ImpactTable } from '../components/common/ImpactTable';
import { SeverityMeter } from '../components/common/SeverityMeter';
import { AppShell } from '../components/layout/AppShell';
import { CHANGE_TYPES, CHANGE_TYPE_LABELS, type ChangeType } from '../constants/changeType';
import { GAP_KIND_LABELS } from '../constants/gapKind';
import { MSG_NO_DOWNSTREAM, MSG_VIEWER_FORBIDDEN } from '../constants/messages';
import { useAuthStore } from '../stores/authStore';
import type { DataAsset } from '../types/dataAsset';
import type { ImpactAnalysis } from '../types/impact';
import { formatDateTime } from '../utils/formatCount';

export function ImpactPage() {
  const isAnalyst = useAuthStore((state) => state.isAnalystOrAbove());
  const [assets, setAssets] = useState<DataAsset[]>([]);
  const [targetAssetId, setTargetAssetId] = useState('');
  const [columns, setColumns] = useState<{ name: string; data_type: string | null }[]>([]);
  const [targetColumn, setTargetColumn] = useState('pay_amount');
  const [changeType, setChangeType] = useState<ChangeType>('change_type');
  const [analysis, setAnalysis] = useState<ImpactAnalysis | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState('');

  useEffect(() => {
    assetsApi
      .list()
      .then((result) => {
        setAssets(result.items);
        const preferred = result.items.find((asset) => asset.display_name === 'dwd.order_detail');
        if (preferred) setTargetAssetId(preferred.id);
      })
      .catch(setError);
    loadHistory();
  }, []);

  useEffect(() => {
    if (!targetAssetId) return;
    assetsApi
      .detail(targetAssetId)
      .then((detail) => setColumns(detail.columns.map((column) => ({ name: column.name, data_type: column.data_type }))))
      .catch(() => setColumns([]));
  }, [targetAssetId]);

  const loadHistory = () => {
    impactApi.history().then((result) => setHistory(result.items)).catch(() => undefined);
  };

  const run = async () => {
    if (!targetAssetId) return;
    setRunning(true);
    setError(null);
    setCopied('');
    try {
      const result = await impactApi.analyze({
        target_asset_id: targetAssetId,
        target_column: targetColumn || null,
        change_type: changeType,
      });
      setAnalysis(result);
      setChecked({});
      loadHistory();
    } catch (err) {
      setError(err);
    } finally {
      setRunning(false);
    }
  };

  const report = analysis?.report_json;
  const checklist = report?.migration_checklist || [];
  const coverage = report?.coverage;
  const checklistComplete = coverage ? coverage.checklist_complete : true;
  const selectedChecklist = useMemo(
    () => checklist.filter((_item, index) => checked[index]),
    [checklist, checked],
  );

  const copySelected = async () => {
    const text = selectedChecklist.map((item) => `-- ${item.asset_name}.${item.column} (${item.action})\n${item.suggested_sql}`).join('\n\n');
    try {
      await navigator.clipboard.writeText(text || checklist.map((item) => item.suggested_sql).join('\n\n'));
      setCopied('已复制建议 SQL 到剪贴板');
    } catch {
      setCopied('浏览器拒绝剪贴板权限，可手动选中下方 SQL 复制');
    }
  };

  return (
    <AppShell eyebrow="影响分析 / IMPACT" title="变更影响分析报告">
      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="row" style={{ gap: 14 }}>
          <div className="field" style={{ minWidth: 230 }}>
            <label>目标资产</label>
            <select
              className="select"
              value={targetAssetId}
              onChange={(event) => {
                setTargetAssetId(event.target.value);
                setTargetColumn('');
              }}
            >
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.display_name}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 180 }}>
            <label>目标列</label>
            <select className="select" value={targetColumn} onChange={(event) => setTargetColumn(event.target.value)}>
              <option value="">（整个资产）</option>
              {columns.map((column) => (
                <option key={column.name} value={column.name}>
                  {column.name} · {column.data_type || '—'}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 170 }}>
            <label>变更类型</label>
            <select
              className="select"
              value={changeType}
              onChange={(event) => setChangeType(event.target.value as ChangeType)}
            >
              {CHANGE_TYPES.map((item) => (
                <option key={item} value={item}>
                  {CHANGE_TYPE_LABELS[item]}
                </option>
              ))}
            </select>
          </div>
          <div style={{ alignSelf: 'flex-end' }}>
            <button type="button" className="btn btn-primary" disabled={!isAnalyst || running} onClick={run}>
              {running ? '分析中…' : '发起影响分析'}
            </button>
          </div>
          {!isAnalyst && (
            <div className="notice warn small" style={{ alignSelf: 'flex-end' }}>
              {MSG_VIEWER_FORBIDDEN}
            </div>
          )}
        </div>
        <ErrorPanel error={error} hint="viewer 发起分析会被后端拒绝并返回 403 + E_FORBIDDEN。" />
      </div>

      {analysis && report && (
        <div className="report-doc">
          <div className="summary-bar">
            <div className="metric">
              <span className="value">
                <SeverityMeter severity={report.summary.severity} />
              </span>
              <span className="label">严重度 Severity</span>
            </div>
            <div className="metric">
              <span className="value">{report.summary.affected_assets}</span>
              <span className="label">受影响资产</span>
            </div>
            <div className="metric">
              <span className="value">{report.summary.affected_columns}</span>
              <span className="label">受影响列</span>
            </div>
            <div className="metric">
              <span className="value">{report.summary.reports}</span>
              <span className="label">报表（不含 cte_result）</span>
            </div>
            <div className="metric">
              <span className="value">{report.summary.min_depth ?? '—'}</span>
              <span className="label">最小传播深度</span>
            </div>
            <div className="metric">
              <span className="value">
                {checklistComplete ? (
                  <span className="badge">清单完整</span>
                ) : (
                  <span className="badge brass">有缺口 · 非完整清单</span>
                )}
              </span>
              <span className="label">迁移清单覆盖度</span>
            </div>
            {analysis.cached && (
              <div className="metric">
                <span className="badge brass">同口径快照</span>
                <span className="label">输入未变，复用历史报告</span>
              </div>
            )}
          </div>

          <hr className="section-rule" />
          <section className="report-section">
            <div className="eyebrow">01 · 目标</div>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="mono">{report.target.asset_name}</span>
              {report.target.column && <ColumnTag column={report.target.column} dark />}
              <span className="badge brass">{CHANGE_TYPE_LABELS[report.target.change_type as ChangeType]}</span>
              <span className="small muted">分析于 {formatDateTime(analysis.created_at)}</span>
            </div>
          </section>

          <hr className="section-rule" />
          <section className="report-section">
            <div className="eyebrow">02 · 受影响资产与列</div>
            {report.nodes.length === 0 ? (
              <div className="notice small" style={{ marginTop: 10 }}>
                {MSG_NO_DOWNSTREAM}
              </div>
            ) : (
              <>
                <div style={{ marginTop: 10 }}>
                  <ImpactTable nodes={report.nodes} />
                </div>
                <CycleWarning cycles={report.cycles} />
                {report.summary.truncated && (
                  <div className="notice warn small" style={{ marginTop: 8 }}>
                    传播深度超过 {report.summary.depth_limit} 步，结果被截断（truncated=true）。
                  </div>
                )}
              </>
            )}
          </section>

          <hr className="section-rule" />
          <section className="report-section">
            <div className="eyebrow">03 · 传播路径（最短路径）</div>
            <div className="stack" style={{ marginTop: 10 }}>
              {report.paths.slice(0, 6).map((item, index) => (
                <div key={index} className="mono small">
                  {(item.path || []).map((node: any) => `${node.asset_name}.${node.column}`).join(' → ')}
                </div>
              ))}
            </div>
          </section>

          <hr className="section-rule" />
          <section className="report-section">
            <div className="eyebrow">04 · 覆盖缺口（血缘无法追踪的边界）</div>
            {!coverage || coverage.total_gap_count === 0 ? (
              <div className="notice small" style={{ marginTop: 10 }}>
                全部相关转换解析成功且列清单完整，迁移清单覆盖当前血缘可达的全部下游。
              </div>
            ) : (
              <>
                <div className="notice warn small" style={{ marginTop: 10 }}>
                  {coverage.disclaimer}
                </div>
                {coverage.uncertain_scope.length > 0 && (
                  <div className="small muted" style={{ marginTop: 6 }}>
                    不确定范围（可能受影响但无法确认的资产）：{coverage.uncertain_scope.join('、')}
                  </div>
                )}
                <table className="data-table dark" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>缺口类型</th>
                      <th>转换</th>
                      <th>涉及资产</th>
                      <th>缺失列</th>
                      <th>影响本次分析</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...coverage.in_scope, ...coverage.other_gaps].map((gap) => (
                      <tr key={gap.gap_id}>
                        <td className="small">{GAP_KIND_LABELS[gap.kind] || gap.kind}</td>
                        <td className="mono small">{gap.transformation_name}</td>
                        <td className="mono small">{gap.asset_name || '—'}</td>
                        <td className="mono small">
                          {gap.missing_columns.length > 0 ? gap.missing_columns.join(', ') : '—'}
                        </td>
                        <td className="small">{gap.in_scope ? '是' : '否（全局）'}</td>
                        <td className="small muted">{gap.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>

          <hr className="section-rule" />
          <section className="report-section">
            <div className="spread">
              <div className="eyebrow">
                05 · 迁移清单（{checklist.length} 条）
                {!checklistComplete && <span className="badge brass" style={{ marginLeft: 8 }}>非完整清单</span>}
              </div>
              <button type="button" className="btn" onClick={copySelected}>
                复制勾选的建议 SQL
              </button>
            </div>
            {!checklistComplete && (
              <div className="notice warn small" style={{ marginTop: 8 }}>
                存在覆盖缺口：以下清单只包含可追踪的下游，缺口中的资产需人工确认，不能当作完整迁移清单使用。
              </div>
            )}
            {copied && <div className="notice small" style={{ marginTop: 8 }}>{copied}</div>}
            {report.excluded_from_checklist.length > 0 && (
              <div className="small muted" style={{ marginTop: 8 }}>
                cte_result 类资产计入受影响面但不进迁移清单：{report.excluded_from_checklist.join('、')}
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              {checklist.map((item, index) => (
                <div key={`${item.asset_id}-${item.column}`} className="checklist-item">
                  <div className="row" style={{ gap: 10 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(checked[index])}
                      onChange={(event) => setChecked((prev) => ({ ...prev, [index]: event.target.checked }))}
                    />
                    <span className="mono">{item.asset_name}</span>
                    <ColumnTag column={item.column} dark />
                    <span className="badge brass">depth {item.depth}</span>
                    <span className="badge">{item.action}</span>
                  </div>
                  <div className="small muted" style={{ marginTop: 4 }}>
                    {item.reason}
                  </div>
                  <code>{item.suggested_sql}</code>
                </div>
              ))}
            </div>
          </section>

          <hr className="section-rule" />
          <section className="report-section">
            <div className="eyebrow">06 · 报告导出</div>
            <div className="row" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement('a');
                  anchor.href = url;
                  anchor.download = `datatrace-impact-${analysis.id.slice(0, 8)}.json`;
                  anchor.click();
                  URL.revokeObjectURL(url);
                }}
              >
                导出 report_json.migration_checklist
              </button>
              <span className="small muted">
                报告 id {analysis.id.slice(0, 8)}
                {report.state_hash && ` · 状态指纹 ${report.state_hash.slice(0, 12)}`}
              </span>
            </div>
          </section>
        </div>
      )}

      <hr className="section-rule" />
      <section>
        <div className="eyebrow">历史报告（快照可回看）</div>
        <table className="data-table dark" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>时间</th>
              <th>目标</th>
              <th>列</th>
              <th>变更类型</th>
              <th>严重度</th>
              <th>受影响列</th>
              <th>清单完整性</th>
            </tr>
          </thead>
          <tbody>
            {history.map((item) => (
              <tr
                key={item.id}
                style={{ cursor: 'pointer' }}
                onClick={async () => {
                  const detail = await impactApi.detail(item.id);
                  setAnalysis(detail);
                }}
              >
                <td className="mono small">{formatDateTime(item.created_at)}</td>
                <td className="mono small">{item.target_asset_name}</td>
                <td className="small">{item.target_column || '（整表）'}</td>
                <td className="small">{CHANGE_TYPE_LABELS[item.change_type as ChangeType]}</td>
                <td>
                  <span className={`sev ${item.severity}`}>{item.severity}</span>
                </td>
                <td className="mono">{item.affected_count}</td>
                <td className="small">
                  {item.summary?.checklist_complete === undefined
                    ? '—'
                    : item.summary.checklist_complete
                      ? '完整'
                      : '有缺口'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {history.length === 0 && <div className="small muted" style={{ marginTop: 8 }}>暂无历史报告。</div>}
      </section>
    </AppShell>
  );
}
