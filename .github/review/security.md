Review this change for security vulnerabilities it introduces or exposes: missing or bypassable authentication and authorization checks, privilege escalation and cross-tenant access; injection (SQL, shell command, path traversal, template); unsafe deserialization; secrets or credentials in code, logs or errors; insecure defaults; missing validation of untrusted input at a trust boundary; and exposure of data to callers who should not see it.

Trace untrusted input from where it enters to where it is used. Report only issues with a plausible exploit path through the changed code, and state the impact.

Do NOT report: general code quality, style, missing tests, or hardening suggestions without a concrete vulnerability.

The signal is true when you report at least one vulnerability, false when you report none.
