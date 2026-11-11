"""ImpactAnalysis 模型（历史快照）。"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.config.database import Base


class ImpactAnalysis(Base):
    __tablename__ = "impact_analyses"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    requested_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    change_type: Mapped[str] = mapped_column(String(24), nullable=False)
    target_asset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("data_assets.id"), nullable=False, index=True
    )
    target_column: Mapped[str | None] = mapped_column(String(128), nullable=True)
    severity: Mapped[str] = mapped_column(String(16), nullable=False, default="low")
    affected_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # 分析输入（血缘边 + 转换解析状态 + 资产列清单）的指纹；
    # 同目标同指纹的历史报告可安全复用，指纹变化即重算。历史快照不回填，保持可追溯。
    state_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    report_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )

    requested_by_user = relationship("User", back_populates="impact_analyses")
    target_asset = relationship("DataAsset", foreign_keys=[target_asset_id])
