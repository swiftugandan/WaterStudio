# Input errors

Networks with input errors, for `oracle/toolkit.sh`: `EN_open` must refuse each with the
same report as OWA-EPANET 2.3.5 (every error's code, blamed token and line, in file order),
and `EN_openX` must open it with the same partly read network. Between them they reach
every error the input parser reports (`input3.c`, `ruledata` in `rules.c`) and every way a
bad line leaves part of itself in the network.

They are kept apart from `oracle/fixtures`, whose networks must run.
