"""impact_analyses add state_hash

Revision ID: 0002_impact_state_hash
Revises: 0001_initial
Create Date: 2026-11-11

为影响分析快照增加输入状态指纹列：
- 新分析按 (target_asset_id, target_column, change_type, state_hash) 判重；
- 历史报告 state_hash 留空（NULL），永不回填、永不改写，保留追溯能力；
- 建索引用于同指纹缓存命中查询。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002_impact_state_hash"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "impact_analyses",
        sa.Column("state_hash", sa.String(length=64), nullable=True),
    )
    op.create_index(
        "ix_impact_analyses_state_hash",
        "impact_analyses",
        ["state_hash"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_impact_analyses_state_hash", table_name="impact_analyses")
    op.drop_column("impact_analyses", "state_hash")
