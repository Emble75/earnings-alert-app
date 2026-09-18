#!/usr/bin/env python
"""Create or update an operator account.

    python scripts/create_user.py alice@example.com --role ADMIN
"""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from sqlalchemy import select  # noqa: E402

from app.core.security import hash_password  # noqa: E402
from app.db.session import session_scope  # noqa: E402
from app.models.enums import UserRole  # noqa: E402
from app.models.user import User  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("email")
    parser.add_argument("--role", choices=[r.value for r in UserRole], default=UserRole.OPERATOR.value)
    parser.add_argument("--name", default=None)
    args = parser.parse_args()

    # Read the password from a prompt rather than argv, so it does not end up
    # in the shell history or the process list.
    password = getpass.getpass("password: ")
    if len(password) < 12:
        print("refusing: use at least 12 characters", file=sys.stderr)
        return 2
    if password != getpass.getpass("confirm: "):
        print("passwords do not match", file=sys.stderr)
        return 2

    email = args.email.strip().lower()
    with session_scope() as session:
        user = session.execute(select(User).where(User.email == email)).scalars().first()
        if user is None:
            user = User(email=email, hashed_password=hash_password(password))
            session.add(user)
            action = "created"
        else:
            user.hashed_password = hash_password(password)
            action = "updated"
        user.role = UserRole(args.role)
        if args.name:
            user.full_name = args.name
        user.is_active = True
    print(f"{action} {email} with role {args.role}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
