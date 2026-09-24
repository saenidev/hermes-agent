"""The inline dispatcher preserves preview snapshot intent and renderer results."""

import json
from types import SimpleNamespace

import pytest

from agent.inline_tool_executors import (
    INLINE_TOOL_EXECUTORS,
    InlineToolContext,
    resolve_invoke_tool_executor,
)


@pytest.mark.parametrize("full", [True, False, None])
@pytest.mark.parametrize("concurrent", [False, True])
def test_preview_snapshot_options_survive_inline_dispatch(full, concurrent):
    calls = []
    answer = {"success": True, "elements": [], "snapshot": "full", "truncated": False}

    def callback(payload):
        calls.append(payload)
        return json.dumps(answer)

    agent = SimpleNamespace(drive_preview_callback=callback, _memory_manager=None)
    execute = (resolve_invoke_tool_executor(agent, "drive_preview") if concurrent
               else INLINE_TOOL_EXECUTORS["drive_preview"])
    assert execute is not None
    args = {"action": "elements", "max": 20}
    if full is not None:
        args["full"] = full

    result = execute(agent, args, InlineToolContext(effective_task_id="preview-task"))

    assert calls == [args]
    assert json.loads(result) == answer