#!/usr/bin/env bash
# Print the verified digest of an obaass-mcp image built by the repo's own workflow.
#
# Usage: scripts/release-handoff.sh <vX.Y.Z | main>
#
# Finds the successful mcp-docker.yml push run for the ref and reads the digest
# of the image tag that run wrote. It checks the build-provenance attestation
# (repo, workflow, and source commit equal to the run's commit) and the cosign
# keyless signature, then prints `image@sha256:…` for pinning. For a vX.Y.Z tag
# the semver image tag is written only by that tag's run. `main` is for checking
# the script itself: a later main run can move the `main` image tag.
# Requires gh (authenticated), docker buildx, cosign, and jq. Exits non-zero on
# any failed check.
set -euo pipefail

REPO=cameronsjo/obaass
IMAGE=ghcr.io/cameronsjo/obaass-mcp
WORKFLOW=mcp-docker.yml

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }
fail() { echo "FAIL: $*" >&2; exit 1; }

main() {
	[[ $# -eq 1 ]] || { usage >&2; exit 2; }
	[[ "$1" == -h || "$1" == --help || "$1" == help ]] && { usage; exit 0; }
	local ref=$1 image_tag ref_kind
	if [[ "$ref" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
		image_tag=${BASH_REMATCH[1]}
		ref_kind=tags
	elif [[ "$ref" == main ]]; then
		image_tag=main
		ref_kind=heads
		echo "note: main is a moving tag; use a vX.Y.Z tag for a hand-off" >&2
	else
		fail "ref must be vX.Y.Z or main, got: $ref"
	fi
	for tool in gh docker cosign jq; do
		command -v "$tool" > /dev/null || fail "$tool is required"
	done

	local run
	run=$(gh run list -R "$REPO" --workflow "$WORKFLOW" --event push --branch "$ref" \
		--status success --limit 1 --json databaseId,headSha,url)
	local run_id head_sha run_url
	run_id=$(jq -r '.[0].databaseId // empty' <<< "$run")
	head_sha=$(jq -r '.[0].headSha // empty' <<< "$run")
	run_url=$(jq -r '.[0].url // empty' <<< "$run")
	[[ -n "$run_id" && -n "$head_sha" ]] || fail "no successful $WORKFLOW push run for $ref"

	local digest
	digest=$(docker buildx imagetools inspect "$IMAGE:$image_tag" --format '{{json .Manifest}}' \
		| jq -r '.digest // empty')
	[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "could not read a digest for $IMAGE:$image_tag"

	local attested
	attested=$(gh attestation verify "oci://$IMAGE@$digest" -R "$REPO" \
		--signer-workflow "$REPO/.github/workflows/$WORKFLOW" --format json)
	local source_sha
	source_sha=$(jq -r '.[0].verificationResult.signature.certificate.sourceRepositoryDigest // empty' <<< "$attested")
	[[ "$source_sha" == "$head_sha" ]] || fail "attested commit $source_sha does not match run commit $head_sha"

	cosign verify "$IMAGE@$digest" \
		--certificate-oidc-issuer https://token.actions.githubusercontent.com \
		--certificate-identity "https://github.com/$REPO/.github/workflows/$WORKFLOW@refs/$ref_kind/$ref" \
		> /dev/null || fail "cosign signature for $IMAGE@$digest did not verify (cosign's reason above)"

	echo "ref:     $ref"
	echo "run:     $run_url"
	echo "commit:  $head_sha"
	echo "tag:     $IMAGE:$image_tag"
	echo "pin:     $IMAGE@$digest"
}

main "$@"
