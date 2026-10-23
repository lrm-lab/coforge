#!/usr/bin/env bash
# Deploy secrets for remote-deploy.sh: reads the host secret files into the
# environment, hands them to Compose only for one invocation, and writes the
# deploy .env. It defines functions and runs nothing; remote-deploy.sh sources
# it, and the functions read secrets_dir, compose_file and COMPOSE_ARGS from there.

load_compose_secrets() {
	AUTHING_APP_ID="$(cat "$secrets_dir/authing_app_id")"
	AUTHING_APP_SECRET="$(cat "$secrets_dir/authing_app_secret")"
	COFORGE_SESSION_SECRET="$(cat "$secrets_dir/coforge_session_secret")"
	COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY="$(cat "$secrets_dir/coforge_agent_credential_encryption_key")"
	COFORGE_WEB_PUSH_PUBLIC_KEY="$(cat "$secrets_dir/coforge_web_push_public_key")"
	COFORGE_WEB_PUSH_PRIVATE_KEY="$(cat "$secrets_dir/coforge_web_push_private_key")"
	COFORGE_FILE_DELIVERY_KEY="$(cat "$secrets_dir/coforge_file_delivery_key")"
	COFORGE_CENTRIFUGO_TOKEN_HMAC_SECRET_KEY="$(cat "$secrets_dir/centrifugo_token_hmac_secret_key")"
	# Optional deployment values; required Compose fields still fail closed.
	for name in COFORGE_CLOUD_CLUSTER_TOKEN COFORGE_CLOUD_IMAGE_UPDATES_PAUSED COFORGE_GITHUB_CLIENT_SECRET COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY COFORGE_GITHUB_APP_SLUG COFORGE_COMMIT_COAUTHOR COFORGE_GITHUB_WEBHOOK_SECRET COFORGE_RETAINED_CLOUD_IMAGE_IDS COFORGE_OIDC_SIGNING_JWKS; do
		printf -v "$name" '%s' ""
		if [ -f "$secrets_dir/${name,,}" ]; then
			printf -v "$name" '%s' "$(cat "$secrets_dir/${name,,}")"
		fi
	done
	for name in AUTHING_APP_ID AUTHING_APP_SECRET COFORGE_SESSION_SECRET COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY COFORGE_WEB_PUSH_PUBLIC_KEY COFORGE_WEB_PUSH_PRIVATE_KEY COFORGE_CENTRIFUGO_TOKEN_HMAC_SECRET_KEY; do
		[ -n "${!name}" ] || {
			printf '%s secret file is empty\n' "$name" >&2
			exit 1
		}
	done
}

compose() {
	AUTHING_APP_ID="$AUTHING_APP_ID" \
		AUTHING_APP_SECRET="$AUTHING_APP_SECRET" \
		COFORGE_SESSION_SECRET="$COFORGE_SESSION_SECRET" \
		COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY="$COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY" \
		COFORGE_WEB_PUSH_PUBLIC_KEY="$COFORGE_WEB_PUSH_PUBLIC_KEY" \
		COFORGE_WEB_PUSH_PRIVATE_KEY="$COFORGE_WEB_PUSH_PRIVATE_KEY" \
		COFORGE_FILE_DELIVERY_KEY="$COFORGE_FILE_DELIVERY_KEY" \
		COFORGE_CLOUD_CLUSTER_TOKEN="$COFORGE_CLOUD_CLUSTER_TOKEN" \
		COFORGE_RETAINED_CLOUD_IMAGE_IDS="$COFORGE_RETAINED_CLOUD_IMAGE_IDS" \
		COFORGE_CLOUD_IMAGE_UPDATES_PAUSED="$COFORGE_CLOUD_IMAGE_UPDATES_PAUSED" \
		COFORGE_CENTRIFUGO_TOKEN_HMAC_SECRET_KEY="$COFORGE_CENTRIFUGO_TOKEN_HMAC_SECRET_KEY" \
		COFORGE_GITHUB_CLIENT_SECRET="$COFORGE_GITHUB_CLIENT_SECRET" \
		COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY="$COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY" \
		COFORGE_GITHUB_APP_SLUG="$COFORGE_GITHUB_APP_SLUG" \
		COFORGE_COMMIT_COAUTHOR="$COFORGE_COMMIT_COAUTHOR" \
		COFORGE_GITHUB_WEBHOOK_SECRET="$COFORGE_GITHUB_WEBHOOK_SECRET" \
		COFORGE_OIDC_SIGNING_JWKS="$COFORGE_OIDC_SIGNING_JWKS" \
		docker compose "${COMPOSE_ARGS[@]}" "$@"
}

write_deploy_env() {
	# Writes .env next to the compose file with chmod 600; never printed.
	local web_image="$1" env_file env_file_tmp centrifugo_config_sha256 caddyfile_sha256
	env_file="$(cd "$(dirname "$compose_file")" && pwd)/.env"
	centrifugo_config_sha256="$(sha256sum "$(dirname "$compose_file")/centrifugo/config.yaml" | awk '{print $1}')"
	caddyfile_sha256="$(sha256sum "$(dirname "$compose_file")/caddy/Caddyfile" | awk '{print $1}')"
	umask 077
	env_file_tmp="$(mktemp "${env_file}.XXXXXX")"
	{
			printf 'COFORGE_WEB_IMAGE=%s\n' "$web_image"
		# A managed datastore supplies its whole URL as a secret file; the bundled
		# postgres and redis services build it from their password files.
		if [ -f "$secrets_dir/database_url" ]; then
			printf 'DATABASE_URL=%s\n' "$(cat "$secrets_dir/database_url")"
		else
			printf 'DATABASE_URL=postgresql://coforge:%s@postgres:5432/coforge\n' "$(cat "$secrets_dir/postgres_password")"
		fi
		if [ -f "$secrets_dir/redis_url" ]; then
			printf 'REDIS_URL=%s\n' "$(cat "$secrets_dir/redis_url")"
		else
			printf 'REDIS_URL=redis://:%s@redis:6379\n' "$(cat "$secrets_dir/redis_password")"
		fi
		printf 'COFORGE_CENTRIFUGO_API_URL=http://centrifugo:8000/api\n'
		printf 'COFORGE_CENTRIFUGO_API_KEY=%s\n' "$(cat "$secrets_dir/centrifugo_http_api_key")"
		printf 'COFORGE_CENTRIFUGO_PROXY_SECRET=%s\n' "$(cat "$secrets_dir/centrifugo_proxy_secret")"
		printf 'COFORGE_CENTRIFUGO_CONFIG_SHA256=%s\n' "$centrifugo_config_sha256"
		printf 'COFORGE_CADDYFILE_SHA256=%s\n' "$caddyfile_sha256"
		printf 'COFORGE_WORKER_JWT_KEY_ID=%s\n' "$(cat "$secrets_dir/worker_jwt_key_id")"
		printf 'COFORGE_WORKER_JWT_PRIVATE_JWK=%s\n' "$(cat "$secrets_dir/worker_jwt_private_jwk")"
	} >"$env_file_tmp"
	chmod 600 "$env_file_tmp"
	mv "$env_file_tmp" "$env_file"
}
