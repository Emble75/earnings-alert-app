"""Notification channels.

Every channel degrades to a no-op that reports failure rather than raising,
so a misconfigured Telegram token can never take down order processing.  The
notification row records the failure and the worker retries it.
"""

from __future__ import annotations

import json
import smtplib
from email.message import EmailMessage
from typing import Any

import httpx

from app.core.logging import get_logger
from app.providers.base import NotificationProvider

logger = get_logger(__name__)


class InAppNotificationProvider(NotificationProvider):
    """Always succeeds: the row in ``notifications`` *is* the delivery."""

    channel = "IN_APP"

    def send(self, *, subject: str, body: str, payload: dict[str, Any] | None = None) -> bool:
        return True


class EmailNotificationProvider(NotificationProvider):
    channel = "EMAIL"

    def __init__(
        self,
        *,
        host: str,
        port: int = 587,
        user: str = "",
        password: str = "",
        sender: str = "",
        recipient: str = "",
        timeout: float = 15.0,
    ) -> None:
        self.host, self.port = host, port
        self.user, self.password = user, password
        self.sender = sender or user
        self.recipient = recipient
        self.timeout = timeout

    def send(self, *, subject: str, body: str, payload: dict[str, Any] | None = None) -> bool:
        if not self.host or not self.recipient:
            logger.warning("email_not_configured", channel=self.channel)
            return False
        message = EmailMessage()
        message["Subject"] = subject
        message["From"] = self.sender
        message["To"] = self.recipient
        message.set_content(body)
        try:
            with smtplib.SMTP(self.host, self.port, timeout=self.timeout) as smtp:
                smtp.starttls()
                if self.user:
                    smtp.login(self.user, self.password)
                smtp.send_message(message)
        except (OSError, smtplib.SMTPException) as exc:
            logger.warning("email_send_failed", error=str(exc))
            return False
        return True


class TelegramNotificationProvider(NotificationProvider):
    channel = "TELEGRAM"

    def __init__(self, *, bot_token: str, chat_id: str, timeout: float = 15.0) -> None:
        self.bot_token, self.chat_id, self.timeout = bot_token, chat_id, timeout

    def send(self, *, subject: str, body: str, payload: dict[str, Any] | None = None) -> bool:
        if not self.bot_token or not self.chat_id:
            logger.warning("telegram_not_configured")
            return False
        try:
            response = httpx.post(
                f"https://api.telegram.org/bot{self.bot_token}/sendMessage",
                json={"chat_id": self.chat_id, "text": f"*{subject}*\n{body}", "parse_mode": "Markdown"},
                timeout=self.timeout,
            )
        except httpx.RequestError as exc:
            logger.warning("telegram_send_failed", error=str(exc))
            return False
        return response.status_code < 400


class DiscordNotificationProvider(NotificationProvider):
    channel = "DISCORD"

    def __init__(self, *, webhook_url: str, timeout: float = 15.0) -> None:
        self.webhook_url, self.timeout = webhook_url, timeout

    def send(self, *, subject: str, body: str, payload: dict[str, Any] | None = None) -> bool:
        if not self.webhook_url:
            logger.warning("discord_not_configured")
            return False
        content = f"**{subject}**\n{body}"
        if payload:
            content += f"\n```json\n{json.dumps(payload, default=str, indent=2)[:1500]}\n```"
        try:
            response = httpx.post(self.webhook_url, json={"content": content[:1900]}, timeout=self.timeout)
        except httpx.RequestError as exc:
            logger.warning("discord_send_failed", error=str(exc))
            return False
        return response.status_code < 400
