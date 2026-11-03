# @casita/integration-testing

`createTestContext`: a stand-in `IntegrationContext` that records what an integration
registers and reports, and lets a test send commands and run actions without the core.

## Must not import

- Anything from the core except `@casita/core/types`.
