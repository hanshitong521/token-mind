# Project Agents Guide

## Java Development Rules
All Java services must follow the Spring Boot 3.x conventions. Use constructor injection. Never use field injection. All controllers must have @Validated annotation. Service layer must handle transactions with @Transactional(readOnly=true) for read operations. Entity classes must use Lombok @Data and @Builder. Mapper XML files must be in resources/mapper/ directory. All SQL queries must use parameterized statements. Never concatenate user input into SQL. Response format must use unified Result<T> wrapper. Error codes follow the E{module}{sequence} pattern. Logging must use SLF4J with structured arguments. Never log sensitive data (passwords, tokens, PII). All REST endpoints must have OpenAPI annotations. Rate limiting is enforced at gateway level, not in service code. Cache strategy: Redis for session data, Caffeine for local computation cache. Message queue: RocketMQ for async processing, Kafka for event streaming. Database: MySQL 8.0 with ShardingSphere for sharding. Connection pool: HikariCP with max 20 connections per service.

## Frontend Development Rules  
React 18 with TypeScript strict mode. Use functional components only. State management: Zustand for global state, React Query for server state. CSS Modules for styling, no inline styles. Component library: internal @corp/ui-kit. All forms must use react-hook-form with zod validation. API calls through generated TanStack Query hooks. Bundle size budget: 200KB initial, 50KB per route chunk. Accessibility: WCAG 2.1 AA compliance required. i18n: react-intl with ICU message format. Testing: Vitest + React Testing Library, minimum 80% coverage.

## Database Migration Rules
All schema changes must go through Flyway migrations. Migration files named V{version}__{description}.sql. Never modify existing migrations. Backward-compatible changes only: add columns with defaults, create new tables. Breaking changes require a two-phase migration plan. Index creation must include CONCURRENTLY keyword for production. All foreign keys must have ON DELETE behavior specified. Large table alterations (>1M rows) require pt-online-schema-change.

## Security Rules
Authentication: JWT with RS256, 15-minute access tokens, 7-day refresh tokens. Authorization: RBAC with resource-level permissions. API keys stored in Vault, never in code or config. CORS whitelist maintained in gateway config. Input validation at controller level with custom validators. Output encoding for all user-generated content. CSRF protection enabled for all state-changing endpoints. Dependency scanning via Snyk in CI pipeline. Secret rotation every 90 days. Audit logging for all admin operations.

## Testing Strategy
Unit tests: JUnit 5 + Mockito, test business logic in isolation. Integration tests: Testcontainers for database, WireMock for external APIs. Contract tests: Pact for inter-service communication. Performance tests: Gatling for load testing, baseline p99 < 200ms. E2E tests: Playwright for critical user journeys. Test data: factory pattern with Faker, never hardcode test data. CI gate: all tests must pass before merge. Flaky test policy: quarantine after 3 failures, fix within 48 hours.

## Deployment Rules
Container images built with multi-stage Dockerfile. Base image: eclipse-temurin:21-jre-alpine. Health check endpoint: /actuator/health. Graceful shutdown: 30-second timeout. Resource limits: 512Mi memory, 0.5 CPU per pod. Horizontal scaling based on CPU utilization > 70%. Blue-green deployment for major versions. Canary deployment for feature releases. Rollback procedure documented in runbook. Monitoring: Prometheus metrics, Grafana dashboards. Alerting: PagerDuty integration for P1 incidents.

## Code Review Checklist
- [ ] Follows naming conventions
- [ ] Has appropriate error handling
- [ ] Includes unit tests
- [ ] No hardcoded values
- [ ] Documentation updated if API changed
- [ ] Performance impact assessed
- [ ] Security implications reviewed
- [ ] Database migration included if schema changed
- [ ] Feature flag added for user-facing changes
- [ ] Backward compatibility verified

## Incident Response
P1: immediate response, all hands on deck, war room created.
P2: respond within 1 hour during business hours.
P3: respond within 4 hours.
P4: next sprint planning.
Post-mortem required for all P1/P2 incidents within 48 hours.
Blameless culture: focus on system improvements, not individual blame.
On-call rotation: weekly, compensated with time off.
Escalation path: on-call → team lead → engineering manager → VP Engineering.
