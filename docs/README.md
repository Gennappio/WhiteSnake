**WhiteSnake documentation**

The [WhiteSnake 2.0 documentation](v2/README.md) describes the agent-network architecture and the executable local foundations at commit `bb85513`.

- [Create a node](v2/create-a-node.md): installation, store configuration, daily work and validation.
- [Build a local network](v2/local-network.md): register directories, delegate, return feedback and run the deterministic example.
- [Parent, child and sandbox](v2/parent-child.md): execution in the child, project ownership, persistent contexts and the two modes.
- [Reconciliation and feedback](v2/reconciliation-and-feedback.md): current commands and the publication model.
- [Network and permissions](v2/network-and-permissions.md): the intended remote service and child-controlled authorization.
- [Reuse, discovery and handoff](v2/reuse-and-handoff.md): components, dynamic profiles, provenance and portability.
- [Implementation status](v2/status.md): what exists and what still needs to be built.
- [Implementation review](v2/implementation-review.md): verified checks, reproduced defects and limits.

[DESIGN.md](../DESIGN.md) records decisions; [milestones](milestones.md) record completed verification. The [earlier development plan](multinode-development-plan.md) remains historical planning context; the v2 documentation incorporates the later persistent-sandbox decision.

**Maintaining these docs.** When implementation changes, update the source baseline and capability table in [status](v2/status.md), the affected command guide and the verification record. Keep design-only interfaces labelled until they exist. Build and run the local example after changing its commands; retain review cases until their fixes have regression coverage. New architectural decisions belong in DESIGN, and completed checks belong in milestones.

