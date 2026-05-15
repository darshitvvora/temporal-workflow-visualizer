"""
Covers: @workflow.signal, @workflow.query, @workflow.update with `name=` kwarg,
dynamic `set_*_handler` and `set_dynamic_*_handler`, wait_condition, and an
update validator paired with an update handler.
"""

from datetime import timedelta
from temporalio import workflow


@workflow.defn
class SignalQueryWorkflow:
    def __init__(self) -> None:
        self._pending: list[str] = []
        self._done: bool = False

    @workflow.run
    async def run(self) -> list[str]:
        # Dynamic handler registration inside run()
        workflow.set_signal_handler("extra_signal", self._handle_extra)
        workflow.set_dynamic_query_handler(self._handle_any_query)

        await workflow.wait_condition(lambda: self._done)
        return self._pending

    @workflow.signal
    def add(self, item: str) -> None:
        self._pending.append(item)

    @workflow.signal(name="external_finish")
    def finish(self) -> None:
        self._done = True

    @workflow.query
    def get_pending(self) -> list[str]:
        return list(self._pending)

    @workflow.update(name="bulk_add")
    async def bulk_add(self, items: list[str]) -> int:
        self._pending.extend(items)
        return len(self._pending)

    @bulk_add.validator
    def _validate_bulk_add(self, items: list[str]) -> None:
        if not items:
            raise ValueError("items must not be empty")

    def _handle_extra(self, payload: str) -> None:
        self._pending.append(payload)

    def _handle_any_query(self, name: str, _args: list) -> str:
        return f"unknown:{name}"
