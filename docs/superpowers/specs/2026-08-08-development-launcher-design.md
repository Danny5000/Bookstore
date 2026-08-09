# Development launcher design

## Objective

Provide a single PowerShell command that prepares and starts the fully containerized development environment, waits for service health, reports useful URLs and follow-up commands, and then returns control to the terminal.

## Interface

The launcher lives at `scripts/start-dev.ps1` and is invoked from PowerShell:

```powershell
.\scripts\start-dev.ps1
```

It is intentionally start-only. Existing Docker Compose commands remain the explicit interface for logs, shutdown, and destructive volume resets.

## Behavior

The script resolves the repository root from its own location so it works regardless of the caller's current directory. It fails fast with a clear message when Node.js, npm, Docker, or Docker Compose is unavailable.

If `.env` is absent, the script copies `.env.example`; it never overwrites an existing `.env`. It then runs `npm ci`, applies committed migrations through the Compose `tools` profile, and starts the development stack with `--build --wait`. Any failed command terminates the launcher with a nonzero exit code.

After the stack becomes healthy, the script exits successfully and prints:

- Storefront URL: `http://localhost:5173`
- Mailpit URL: `http://localhost:8025`
- The command for following app and worker logs
- The non-destructive shutdown command

## Safety

The launcher does not overwrite developer configuration, stop unrelated containers, remove volumes, or delete data. Every Compose command explicitly names `.env` and `compose.dev.yaml` and executes from the repository root.

## Verification

Automated tests will verify the script's PowerShell syntax and its fail-fast command orchestration without starting or deleting persistent project resources. Final verification will run the repository quality gates and confirm the launcher starts the existing migration-first development topology successfully.
