"""
Covers child workflows (execute + start), external workflow handles,
local activities, Nexus client creation, and parallel gather of child results.
"""

import asyncio
from datetime import timedelta
from temporalio import workflow


@workflow.defn
class ChildOrchestratorWorkflow:
    @workflow.run
    async def run(self, ids: list[str]) -> list[str]:
        handles = [
            await workflow.start_child_workflow(
                "GreetingWorkflow", id_, id=f"greeting-{id_}"
            )
            for id_ in ids
        ]

        results = await asyncio.gather(*[h.result() for h in handles])

        # Local activity
        await workflow.execute_local_activity(
            "audit_log", args=[ids], start_to_close_timeout=timedelta(seconds=5)
        )

        # External signal
        ext = workflow.get_external_workflow_handle_for(
            "OtherWorkflow", workflow_id="other"
        )
        await ext.signal("ping")

        # Nexus
        nexus = workflow.create_nexus_client(endpoint="ep", service="svc")
        nexus  # silence unused

        # Plain (non-`start_`) child
        final = await workflow.execute_child_workflow(
            "AggregationWorkflow", results, id="agg"
        )
        return final
