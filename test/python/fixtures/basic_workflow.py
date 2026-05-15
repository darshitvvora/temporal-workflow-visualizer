"""
Covers: workflow.defn, workflow.run, execute_activity, sleep, info, uuid4,
patched, continue_as_new, basic try/except with activity error branch.
"""

from datetime import timedelta
from temporalio import workflow
from temporalio.exceptions import ActivityError


@workflow.defn
class BasicWorkflow:
    @workflow.run
    async def run(self, account_id: str) -> str:
        workflow.logger.info(f"Starting for {account_id}")

        idempotency_key = workflow.uuid4()

        if workflow.patched("v2-charges"):
            await workflow.sleep(timedelta(seconds=5))

        try:
            result = await workflow.execute_activity(
                "charge_card",
                args=[account_id, idempotency_key],
                start_to_close_timeout=timedelta(seconds=30),
            )
        except ActivityError:
            await workflow.execute_activity(
                "refund_card",
                args=[account_id, idempotency_key],
                start_to_close_timeout=timedelta(seconds=30),
            )
            raise

        if result == "RETRY":
            workflow.continue_as_new(account_id)

        return result
