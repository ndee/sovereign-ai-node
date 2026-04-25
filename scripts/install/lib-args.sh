# shellcheck shell=bash
# lib-args: command-line argument parsing and service-identity normalization.
#
# Mutates top-level globals (REPO_URL, SOURCE_DIR, INSTALL_ROOT, SERVICE_USER,
# SERVICE_GROUP, API_HOST, API_PORT, REQUEST_FILE, RUN_INSTALL, NON_INTERACTIVE,
# ACTION, ...) defined in the sourcing environment.

normalize_service_identity() {
  if [[ -z "$SERVICE_GROUP" ]]; then
    SERVICE_GROUP="$SERVICE_USER"
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo-url)
        REPO_URL="$2"
        shift 2
        ;;
      --source-dir)
        SOURCE_DIR="$2"
        shift 2
        ;;
      --ref)
        REF="$2"
        shift 2
        ;;
      --bots-repo-url)
        BOTS_REPO_URL="$2"
        shift 2
        ;;
      --bots-source-dir)
        BOTS_SOURCE_DIR="$2"
        shift 2
        ;;
      --bots-ref)
        BOTS_REF="$2"
        shift 2
        ;;
      --install-root)
        INSTALL_ROOT="$2"
        APP_DIR="${INSTALL_ROOT}/app"
        BOTS_DIR="${INSTALL_ROOT}/sovereign-ai-bots"
        shift 2
        ;;
      --service-user)
        SERVICE_USER="$2"
        shift 2
        ;;
      --service-group)
        SERVICE_GROUP="$2"
        shift 2
        ;;
      --api-host)
        API_HOST="$2"
        shift 2
        ;;
      --api-port)
        API_PORT="$2"
        shift 2
        ;;
      --request-file)
        REQUEST_FILE="$2"
        shift 2
        ;;
      --install)
        if [[ "$ACTION" == "update" ]]; then
          die "Cannot use --install and --update together"
        fi
        ACTION="install"
        shift
        ;;
      --update)
        if [[ "$ACTION" == "install" ]]; then
          die "Cannot use --install and --update together"
        fi
        ACTION="update"
        shift
        ;;
      --skip-install-run)
        RUN_INSTALL="0"
        shift
        ;;
      --non-interactive)
        NON_INTERACTIVE="1"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "Unknown argument: $1"
        ;;
    esac
  done

  case "$ACTION" in
    ""|install|update)
      ;;
    *)
      die "Unsupported action '${ACTION}'. Use install or update."
      ;;
  esac
}
