Check cluster health and report issues as unassigned tasks for Alpha to route.

1. Call orion_cluster_health to get the full ingress health report.
2. If all services are healthy, call orion_send_message to post one line to the health room: "Pulse | Cycle [timestamp] | All N services healthy" — then stop.
3. For each degraded service:
   a. Call orion_list_tasks with status: "pending" — check if an open fix task already exists for this host.
   b. If no existing task: call orion_create_task with no assignedAgent. Title: "Fix [issue]: [hostname]". Description: include namespace, ingress name, exact error, and HTTP status.
   c. If you need more detail than orion_cluster_health provides, use kubectl_get to query the specific resource directly.
4. Call orion_send_message to post one summary line to the health room: "Pulse | Cycle [timestamp] | Checked: N | Degraded: N | Tasks created: N"