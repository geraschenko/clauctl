I don't like how trees are presented. Specifically, I don't like that short branches get shunted towards the _bottom_. For example, `clauctl get-entries -t 75e1 | clauctl format tree --filter all` ends like this:

```
│     └─ ff1a9f7a user: Now try calling Bash 5 times in the same response. The calls can be trivial…
│           208276f0 attachment
│           8617b1a1 assistant: [tool: Bash]
│           ├─ de9d72ae assistant: [tool: Bash]
│           │     ac11eb43 Bash: ok
│           │     60e9e035 assistant: [tool: Bash]
│           │     ├─ 97ee02c1 assistant: [tool: Bash]
│           │     │     b974d8d3 Bash: ok
│           │     │     c6c96777 assistant: [tool: Bash]
│           │     │     20802656 Bash: ok
│           │     │     95f35827 attachment
│           │     │     563e13de assistant: Done — five Bash calls issued in one turn, each returni…
│           │     │     81471682 user: Nice work. Thanks.
│           │     │     07366210 attachment
│           │     │     08327d8a assistant: Happy to help — good luck with the session-file analysi…
│           │     └─ 45d5d9c3 Bash: ok
│           └─ 8bc83b89 Bash: ok
└─ db9a180b Bash: ok
```

whereas I think it should end like this, using way less indentation:

```
ff1a9f7a user: Now try calling Bash 5 times in the same response.
8617b1a1 assistant: [tool: Bash]
├─ 8bc83b89 Bash: ok
de9d72ae assistant: [tool: Bash]
ac11eb43 Bash: ok
60e9e035 assistant: [tool: Bash]
├─ 45d5d9c3 Bash: ok
97ee02c1 assistant: [tool: Bash]
b974d8d3 Bash: ok
c6c96777 assistant: [tool: Bash]
20802656 Bash: ok
563e13de assistant: Done — five Bash calls issued in one turn, each returni…
```

Alternatively (probably better) is to use @geraschenko/renderdag, which makes the tree structure clearer. We could then also use different glyphs for user/assistant/tool_call/tool_result/boundary/etc to make things much easier to digest at a glance. Note that for us "time flows down" and for renderdag "time flows up", so we'd have to build a _children_ map out of our parent map. If we use renderdag, then I think we should present the entries in strict chronological order, or at least have the _option_ to show them in strict chronological order (and it should be the default). That way we're actually communicating strictly more than the parentMap.
