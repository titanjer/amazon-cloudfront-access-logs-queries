#!/usr/bin/env bash

##
# This configures an S3 bucket ObjectCreated notification for the given Lambda
# function so that when a file is uploaded the Lambda function is invoked. This
# is useful when the bucket is not defined in the same CloudFormation template
# as the function. CloudFormation cannot setup the notification in this case.
#
# Note that the AWS CLI is used and will require valid AWS credentials for the
# account containing the resources. The 'jq' JSON processor is also required
# for manipulating JSON (see https://stedolan.github.io/jq/).
#
# See the following GitHub issue for more discussion:
#   https://github.com/awslabs/serverless-application-model/issues/124
##

highlight() { echo -e "\033[36m$*\033[0m"; }
info() { echo -e "\033[36mINFO: $*\033[0m"; }
success() { echo -e "\033[32m$*\033[0m"; }
fail() { echo -e "\033[31mERROR: $*\033[0m" >&2; exit 1; }

##
# Usage information.
##
usage() {
  cat <<-EOM
Configure an S3 bucket ObjectCreated notification for the given Lambda function.

Usage: $(highlight "./$(basename "${BASH_SOURCE[0]}") BUCKET FUNCTION")

Arguments:
  $(highlight BUCKET)     name of the S3 bucket that should trigger the notification
  $(highlight FUNCTION)   name of the Lambda function that should receive the notification

EOM
}

##
# Verify requirements.
##
BUCKET_NAME=$1
FUNC_NAME=$2
S3_PREFIX=$3

[ -z "${BUCKET_NAME}" ] && usage && fail 'Required argument BUCKET is missing.'
[ -z "${FUNC_NAME}" ] && usage && fail 'Required argument FUNCTION is missing.'
[ -z "${S3_PREFIX}" ] && usage && fail 'Required argument S3_PREFIX is missing.'

command -v aws >/dev/null || fail 'AWS CLI is missing.'
command -v jq >/dev/null || fail 'jq is missing.'

aws iam get-user >/dev/null 2>&1 || fail 'Unable to locate your AWS credentials.'

##
# Verify the resources exist.
##
aws s3api head-bucket --bucket "${BUCKET_NAME}" 2>/dev/null
[ $? -ne 0 ] && fail "Could not find bucket ${BUCKET_NAME}."

FUNC_ARN=$(
  aws lambda get-function \
    --function-name "${FUNC_NAME}" 2>/dev/null \
    | jq -r '.Configuration.FunctionArn'
)

[ -z "${FUNC_ARN}" ] && fail "Could not find function ${FUNC_NAME}."

##
# Exit early if the notification has already been configured.
##
NOTIFICATIONS=$(
  aws s3api get-bucket-notification-configuration --bucket "${BUCKET_NAME}"
)

NOTIFICATION_ARNS=($(
  echo "${NOTIFICATIONS}" | jq -r '.LambdaFunctionConfigurations[].LambdaFunctionArn'
))

if [[ " ${NOTIFICATION_ARNS[*]} " =~ ${FUNC_ARN} ]];
then
  info "Notification already configured for function ${FUNC_NAME}."
  exit 0
fi

##
# Ensure S3 has permission to invoke the Lambda function.
#
# See existing permissions with:
#   aws lambda get-policy --function-name "${FUNC_NAME}"
#
# Remove the permission with:
#   aws lambda remove-permission --function-name "${FUNC_NAME}" --statement-id "${BUCKET_NAME}"
##
PERMISSION=$(
  aws lambda get-policy --function-name "${FUNC_NAME}" 2>/dev/null \
    | jq '.Policy | fromjson | .Statement[] | select(.Sid == "'"${BUCKET_NAME}"'")'
)

if [ -z "${PERMISSION}" ]
then
  aws lambda add-permission \
    --function-name "${FUNC_NAME}" \
    --statement-id "${BUCKET_NAME}" \
    --action "lambda:InvokeFunction" \
    --principal "s3.amazonaws.com" \
    --source-arn "arn:aws:s3:::${BUCKET_NAME}" \
    >/dev/null

  if [ $? -ne 0 ]
  then
    fail 'There was a problem configuring the function policy.'
  fi

  info 'Updated function policy to allow notifications from bucket.'
fi

##
# Configure the bucket notification.
##
NOTIFICATION=$(
  cat <<-EOF
  {
    "Id": "${FUNC_NAME}",
    "LambdaFunctionArn": "${FUNC_ARN}",
    "Events": [ "s3:ObjectCreated:*" ],
    "Filter": {
      "Key": {
        "FilterRules": [
          {
            "Name": "prefix",
            "Value": "${S3_PREFIX}"
          }
        ]
      }
    }

  }
EOF
)

EMPTY={}
NOTIFICATIONS=$(
  echo "${NOTIFICATIONS:-$EMPTY}" | jq '.LambdaFunctionConfigurations |= . + ['"${NOTIFICATION}"']'
)

aws s3api put-bucket-notification-configuration \
  --notification-configuration "${NOTIFICATIONS}" \
  --bucket "${BUCKET_NAME}"

[ $? -ne 0 ] && fail 'There was a problem configuring the bucket notification.'

success 'Updated bucket notification configuration.' \
  'Log in to the AWS console and verify the configuration at' \
  "https://s3.console.aws.amazon.com/s3/buckets/${BUCKET_NAME}/?tab=properties"
