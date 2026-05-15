"""
Saga / compensation pattern with nested control flow:
  - if/else gating an activity
  - try/except with compensating activities + raise
  - for loop wrapping retries
  - asyncio.gather of two activities (parallel)
  - workflow.continue_as_new exit
"""

import asyncio
from datetime import timedelta
from temporalio import workflow
from temporalio.exceptions import ActivityError, ApplicationError


@workflow.defn
class TransferSagaWorkflow:
    @workflow.run
    async def run(self, src: str, dst: str, amount: float, retries: int = 3) -> str:
        if amount <= 0:
            raise ApplicationError("amount must be positive")

        for attempt in range(retries):
            try:
                debited = await workflow.execute_activity(
                    "debit_account",
                    args=[src, amount],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                credited = await workflow.execute_activity(
                    "credit_account",
                    args=[dst, amount],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                # Parallel post-transaction notifications
                await asyncio.gather(
                    workflow.execute_activity(
                        "notify_source", args=[src], start_to_close_timeout=timedelta(seconds=10)
                    ),
                    workflow.execute_activity(
                        "notify_dest", args=[dst], start_to_close_timeout=timedelta(seconds=10)
                    ),
                )
                return f"ok:{debited}->{credited}"
            except ActivityError:
                # Compensation: refund whatever was debited.
                await workflow.execute_activity(
                    "refund_account",
                    args=[src, amount],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                if attempt == retries - 1:
                    raise
                await workflow.sleep(timedelta(seconds=2 ** attempt))

        workflow.continue_as_new(src, dst, amount, retries)
        return "continued"
