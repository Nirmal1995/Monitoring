#!/bin/sh
# Idempotent storage bootstrap, run by the storage-init one-shot container.
#  - creates private buckets
#  - creates an application user limited to those buckets (least privilege)
set -eu

ALIAS=local
mc alias set "$ALIAS" http://storage:9000 "$STORAGE_ROOT_USER" "$STORAGE_ROOT_PASSWORD" >/dev/null

for bucket in "$S3_BUCKET_UPLOADS" "$S3_BUCKET_MEDIA"; do
  mc mb --ignore-existing "$ALIAS/$bucket"
  # Private: no anonymous access. All access goes through signed URLs.
  mc anonymous set none "$ALIAS/$bucket" >/dev/null
done

POLICY_FILE=/tmp/streamhub-app-policy.json
cat > "$POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS", "arn:aws:s3:::$S3_BUCKET_MEDIA"]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": ["arn:aws:s3:::$S3_BUCKET_UPLOADS/*", "arn:aws:s3:::$S3_BUCKET_MEDIA/*"]
    }
  ]
}
JSON

# "policy create" replaces the policy if it already exists, so edits here apply on next run.
mc admin policy create "$ALIAS" streamhub-app "$POLICY_FILE" >/dev/null

if mc admin user info "$ALIAS" "$S3_ACCESS_KEY_ID" >/dev/null 2>&1; then
  echo "[streamhub] app user exists"
else
  mc admin user add "$ALIAS" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"
  echo "[streamhub] created app user"
fi
# attach fails if the policy is already attached; that case is fine.
if ! mc admin user info "$ALIAS" "$S3_ACCESS_KEY_ID" | grep -q streamhub-app; then
  mc admin policy attach "$ALIAS" streamhub-app --user "$S3_ACCESS_KEY_ID"
fi

echo "[streamhub] storage init complete"
