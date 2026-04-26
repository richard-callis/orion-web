#!/bin/bash

################################################################################
# SOC II Compliance Smoke Test Suite — Quick Start
#
# Usage:
#   ./SMOKE_TESTS_QUICK_START.sh [setup|run|cleanup|all]
#
# Examples:
#   ./SMOKE_TESTS_QUICK_START.sh setup      # Initialize test environment
#   ./SMOKE_TESTS_QUICK_START.sh run        # Run all smoke tests
#   ./SMOKE_TESTS_QUICK_START.sh cleanup    # Tear down test environment
#   ./SMOKE_TESTS_QUICK_START.sh all        # Setup + run tests
#
################################################################################

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$SCRIPT_DIR/deploy"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_DIR="$SCRIPT_DIR/test-results/$TIMESTAMP"
RESULTS_FILE="$LOG_DIR/test-results.txt"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Utility functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# Verify prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    if ! command -v docker &> /dev/null; then
        log_fail "Docker not found. Please install Docker."
        exit 1
    fi

    if ! command -v docker-compose &> /dev/null; then
        log_fail "Docker Compose not found. Please install Docker Compose."
        exit 1
    fi

    if ! command -v curl &> /dev/null; then
        log_fail "curl not found. Please install curl."
        exit 1
    fi

    if ! command -v jq &> /dev/null; then
        log_warn "jq not found. Some tests may not parse JSON properly."
    fi

    log_pass "Prerequisites check passed"
}

# Setup: Initialize test environment
setup() {
    log_info "Setting up test environment..."

    # Create log directory
    mkdir -p "$LOG_DIR"
    log_pass "Created log directory: $LOG_DIR"

    # Check if .env exists
    if [ ! -f "$DEPLOY_DIR/.env" ]; then
        log_warn "No .env file found. Copying from .env.example..."
        cp "$DEPLOY_DIR/.env.example" "$DEPLOY_DIR/.env"
        log_warn "Please configure .env with your settings before running tests"
    fi

    # Start Docker services
    log_info "Starting Docker Compose services..."
    cd "$DEPLOY_DIR"
    docker-compose up -d

    log_info "Waiting for services to be healthy (60 seconds)..."
    local max_wait=60
    local elapsed=0

    while [ $elapsed -lt $max_wait ]; do
        ORION_HEALTHY=$(docker-compose exec -T orion curl -f http://localhost:3000/api/health &>/dev/null && echo "true" || echo "false")
        POSTGRES_HEALTHY=$(docker-compose exec -T postgres pg_isready -U orion &>/dev/null && echo "true" || echo "false")
        REDIS_HEALTHY=$(docker-compose exec -T redis redis-cli ping &>/dev/null && echo "true" || echo "false")

        if [ "$ORION_HEALTHY" = "true" ] && [ "$POSTGRES_HEALTHY" = "true" ] && [ "$REDIS_HEALTHY" = "true" ]; then
            log_pass "All services healthy"
            return 0
        fi

        echo -n "."
        sleep 5
        elapsed=$((elapsed + 5))
    done

    log_fail "Services did not become healthy within 60 seconds"
    log_info "Current service status:"
    docker-compose ps
    exit 1
}

# Run smoke tests
run_tests() {
    log_info "Running smoke tests..."

    mkdir -p "$LOG_DIR"

    echo "=== SOC II Compliance Smoke Tests ===" | tee -a "$RESULTS_FILE"
    echo "Start Time: $(date)" | tee -a "$RESULTS_FILE"
    echo "Log Directory: $LOG_DIR" | tee -a "$RESULTS_FILE"
    echo "" | tee -a "$RESULTS_FILE"

    # Test counters
    local total=0
    local passed=0
    local failed=0

    # K8S-001: Console Log Redaction
    log_info "Testing K8S-001: Console Log Redaction"
    total=$((total + 1))
    if test_k8s_001; then
        log_pass "K8S-001: Console Log Redaction"
        passed=$((passed + 1))
        echo "K8S-001: PASS" | tee -a "$RESULTS_FILE"
    else
        log_fail "K8S-001: Console Log Redaction"
        failed=$((failed + 1))
        echo "K8S-001: FAIL" | tee -a "$RESULTS_FILE"
    fi

    # INPUT-001: Input Validation
    log_info "Testing INPUT-001: Input Validation"
    total=$((total + 1))
    if test_input_001; then
        log_pass "INPUT-001: Input Validation"
        passed=$((passed + 1))
        echo "INPUT-001: PASS" | tee -a "$RESULTS_FILE"
    else
        log_fail "INPUT-001: Input Validation"
        failed=$((failed + 1))
        echo "INPUT-001: FAIL" | tee -a "$RESULTS_FILE"
    fi

    # SQL-001: Parameterized Queries
    log_info "Testing SQL-001: Parameterized Queries"
    total=$((total + 1))
    if test_sql_001; then
        log_pass "SQL-001: Parameterized Queries"
        passed=$((passed + 1))
        echo "SQL-001: PASS" | tee -a "$RESULTS_FILE"
    else
        log_fail "SQL-001: Parameterized Queries"
        failed=$((failed + 1))
        echo "SQL-001: FAIL" | tee -a "$RESULTS_FILE"
    fi

    # RATE-001: Rate Limiting
    log_info "Testing RATE-001: Rate Limiting"
    total=$((total + 1))
    if test_rate_001; then
        log_pass "RATE-001: Rate Limiting"
        passed=$((passed + 1))
        echo "RATE-001: PASS" | tee -a "$RESULTS_FILE"
    else
        log_fail "RATE-001: Rate Limiting"
        failed=$((failed + 1))
        echo "RATE-001: FAIL" | tee -a "$RESULTS_FILE"
    fi

    # CSP-001: Content Security Policy
    log_info "Testing CSP-001: Content Security Policy"
    total=$((total + 1))
    if test_csp_001; then
        log_pass "CSP-001: Content Security Policy"
        passed=$((passed + 1))
        echo "CSP-001: PASS" | tee -a "$RESULTS_FILE"
    else
        log_fail "CSP-001: Content Security Policy"
        failed=$((failed + 1))
        echo "CSP-001: FAIL" | tee -a "$RESULTS_FILE"
    fi

    # SSO-001: HMAC Validation
    log_info "Testing SSO-001: HMAC Validation"
    total=$((total + 1))
    if test_sso_001; then
        log_pass "SSO-001: HMAC Validation"
        passed=$((passed + 1))
        echo "SSO-001: PASS" | tee -a "$RESULTS_FILE"
    else
        log_fail "SSO-001: HMAC Validation"
        failed=$((failed + 1))
        echo "SSO-001: FAIL" | tee -a "$RESULTS_FILE"
    fi

    # AUDIT-001: S3 Export
    log_info "Testing AUDIT-001: S3 Audit Export"
    total=$((total + 1))
    if test_audit_001; then
        log_pass "AUDIT-001: S3 Audit Export"
        passed=$((passed + 1))
        echo "AUDIT-001: PASS" | tee -a "$RESULTS_FILE"
    else
        log_fail "AUDIT-001: S3 Audit Export"
        failed=$((failed + 1))
        echo "AUDIT-001: FAIL" | tee -a "$RESULTS_FILE"
    fi

    # Summary
    echo "" | tee -a "$RESULTS_FILE"
    echo "=== Test Summary ===" | tee -a "$RESULTS_FILE"
    echo "Total Tests: $total" | tee -a "$RESULTS_FILE"
    echo "Passed: $passed" | tee -a "$RESULTS_FILE"
    echo "Failed: $failed" | tee -a "$RESULTS_FILE"
    echo "End Time: $(date)" | tee -a "$RESULTS_FILE"

    if [ $failed -eq 0 ]; then
        log_pass "All tests passed!"
        return 0
    else
        log_fail "$failed test(s) failed"
        return 1
    fi
}

# Individual test functions
test_k8s_001() {
    # Quick check: verify wrapConsoleLog is called
    local logs=$(docker-compose logs orion 2>&1 | grep -i "redact\|wrap" | wc -l)
    [ $logs -gt 0 ]
}

test_input_001() {
    # Quick check: POST with empty body should return 400
    local status=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/tasks \
        -H "Content-Type: application/json" \
        -d '{}')
    [ "$status" = "400" ]
}

test_sql_001() {
    # Quick check: verify no SQL injection errors
    curl -X POST http://localhost:3000/api/tasks \
        -H "Content-Type: application/json" \
        -d '{"title": "test; DROP TABLE;"}' &>/dev/null

    # Verify table still exists
    docker-compose exec -T postgres psql -U orion -d orion -c "SELECT COUNT(*) FROM Task;" &>/dev/null
}

test_rate_001() {
    # Quick check: 11 requests should include at least one 429
    local has_429=false
    for i in {1..11}; do
        local status=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health)
        if [ "$status" = "429" ]; then
            has_429=true
            break
        fi
        sleep 0.2
    done
    [ "$has_429" = "true" ]
}

test_csp_001() {
    # Quick check: verify CSP header is present
    local csp=$(curl -sD /dev/stdout http://localhost:3000 2>&1 | grep -i "content-security-policy" | wc -l)
    [ $csp -gt 0 ]
}

test_sso_001() {
    # Quick check: SSO request without HMAC should fail
    local status=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/auth/sso \
        -H "X-SSO-User: test" \
        -d '{}')
    [ "$status" = "401" ] || [ "$status" = "403" ]
}

test_audit_001() {
    # Quick check: MinIO is running and bucket exists
    docker-compose exec -T minio mc ls local/orion-audit-logs &>/dev/null
}

# Cleanup: Tear down test environment
cleanup() {
    log_info "Cleaning up test environment..."

    cd "$DEPLOY_DIR"
    log_info "Stopping Docker Compose services..."
    docker-compose down

    log_pass "Cleanup complete"
}

# Main script
main() {
    local action="${1:-all}"

    check_prerequisites

    case "$action" in
        setup)
            setup
            ;;
        run)
            run_tests
            ;;
        cleanup)
            cleanup
            ;;
        all)
            setup
            if run_tests; then
                log_pass "All tests passed!"
                cleanup
                exit 0
            else
                log_fail "Some tests failed. Keeping environment for debugging."
                log_info "Review logs in: $LOG_DIR"
                exit 1
            fi
            ;;
        *)
            echo "Usage: $0 [setup|run|cleanup|all]"
            exit 1
            ;;
    esac
}

main "$@"
