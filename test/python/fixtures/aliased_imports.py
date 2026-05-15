"""
Covers alias resolution:
  - `from temporalio import workflow as wf`
  - `from temporalio.workflow import sleep, execute_activity as exec_act`
  - `from temporalio.workflow import unsafe`
  - `from temporalio.exceptions import ActivityError as AE`
  - `import asyncio` (plain)

Every Temporal call here is via an alias. The recognizer must still classify
each one correctly.
"""

import asyncio
from datetime import timedelta
from temporalio import workflow as wf
from temporalio.workflow import sleep, execute_activity as exec_act, unsafe
from temporalio.exceptions import ActivityError as AE


@wf.defn
class AliasedWorkflow:
    @wf.run
    async def run(self) -> None:
        if unsafe.is_replaying():
            wf.logger.debug("replaying")

        await sleep(timedelta(seconds=1))

        try:
            await exec_act("step_one", start_to_close_timeout=timedelta(seconds=30))
        except AE:
            await exec_act("compensate", start_to_close_timeout=timedelta(seconds=30))

        await asyncio.gather(
            wf.execute_activity("step_two", start_to_close_timeout=timedelta(seconds=30)),
            wf.execute_activity("step_three", start_to_close_timeout=timedelta(seconds=30)),
        )
