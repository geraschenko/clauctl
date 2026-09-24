I'd sometimes like to be able to spawn a new agent, forking an existing agent at a particular entry id.
clauctl fork -t EXISTING_AGENT_ID [--at ENTRY_UUID] [--attach|-a]

A possible implementation is to `--rewind-to ENTRY_UUID`, then spawn with `--fork SESSION_ID`, then `--rewind-to PREVIOUS_LEAF`. This has the advantage that the claude CLI does the work of copying what it needs to from the old session file. The disadvantage is that it requires briefly modifying the state of the existing agent, which could be a problem if the existing agent is currently working (though only if --at is provided ... forking a running agent at its current leaf doesn't require touching it). This disadvantage seems acceptable to me.
