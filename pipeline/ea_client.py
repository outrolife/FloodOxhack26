"""Thin, cached wrappers around the EA Hydrology and flood-monitoring APIs (SPEC §5.1).

Responses are cached under data/raw/ and never re-downloaded; retries with backoff;
live endpoints are polled at most every 15 minutes.

Issue #3. See SPEC.md for the full specification.
"""
from __future__ import annotations
