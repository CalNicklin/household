import { useState } from "react";
import { Button, Card, Field, Form, Page, Text, TextInput } from "../design-system/index.ts";

/** Only same-site paths are followed after login. */
function safeNext(next: string | undefined): string {
  return next !== undefined && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/** PRV-6: the only page reachable without a login. */
export function LoginScreen({ next }: { next: string | undefined }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [failed, setFailed] = useState(false);
  const submit = async () => {
    const res = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }), credentials: "same-origin" });
    if (res.ok) window.location.assign(safeNext(next));
    else setFailed(true);
  };
  return (
    <Page label="Log in">
      <Card>
        <Form label="Log in" onSubmit={() => void submit()}>
          <Text>Household</Text>
          <Field label="Name">
            <TextInput label="Name" name="username" autoComplete="username" value={username} onChange={setUsername} />
          </Field>
          <Field label="Password">
            <TextInput label="Password" name="password" type="password" autoComplete="current-password" value={password} onChange={setPassword} />
          </Field>
          <Button type="submit" variant="primary" large>
            Log in
          </Button>
          {failed ? <Text tone="alert">That didn't match. Try again.</Text> : null}
        </Form>
      </Card>
    </Page>
  );
}
