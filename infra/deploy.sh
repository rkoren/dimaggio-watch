#!/usr/bin/env bash
# Packages the refresher Lambda and deploys the data-pipeline stack.
#
#   ./infra/deploy.sh
#
# Requires the AWS CLI with credentials for the dimaggio-watch account.
# Idempotent: re-running only updates what changed (the code key is
# content-hashed, so an unchanged zip is a no-op).
set -euo pipefail

cd "$(dirname "$0")/.."

STACK=dimaggio-watch-data
REGION=${AWS_REGION:-us-east-1}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
CODE_BUCKET=dimaggio-watch-artifacts-$ACCOUNT

# Artifacts bucket lives outside the stack (the stack's code has to be
# somewhere before the stack exists). Private; create once.
if ! aws s3api head-bucket --bucket "$CODE_BUCKET" 2>/dev/null; then
  echo "Creating artifacts bucket $CODE_BUCKET..."
  aws s3api create-bucket --bucket "$CODE_BUCKET" --region "$REGION"
fi

# Package: handler.mjs at the zip root, shared logic under src/.
BUILD_DIR=$(mktemp -d)
trap 'rm -rf "$BUILD_DIR"' EXIT
cp lambda/handler.mjs "$BUILD_DIR/"
mkdir -p "$BUILD_DIR/src"
cp src/*.mjs "$BUILD_DIR/src/"
(cd "$BUILD_DIR" && zip -qr code.zip handler.mjs src)

HASH=$(shasum -a 256 "$BUILD_DIR/code.zip" | cut -c1-16)
CODE_KEY="lambda/refresh-$HASH.zip"
aws s3 cp --quiet "$BUILD_DIR/code.zip" "s3://$CODE_BUCKET/$CODE_KEY"

echo "Deploying stack $STACK (code: $CODE_KEY)..."
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK" \
  --template-file infra/template.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides CodeBucket="$CODE_BUCKET" CodeKey="$CODE_KEY"

aws cloudformation describe-stacks \
  --region "$REGION" --stack-name "$STACK" \
  --query 'Stacks[0].Outputs' --output table
