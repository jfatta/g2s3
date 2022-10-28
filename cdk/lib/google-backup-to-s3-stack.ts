import * as cdk from 'aws-cdk-lib';
import {aws_events as events, aws_sns as sns, Stack} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {Schedule} from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import {BatchJob} from "aws-cdk-lib/aws-events-targets";
import * as batch from 'aws-cdk-lib/aws-batch';
import {CfnComputeEnvironment} from 'aws-cdk-lib/aws-batch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import {Bucket} from "aws-cdk-lib/aws-s3";
import {CronOptions} from "aws-cdk-lib/aws-events/lib/schedule";
import {SubscriptionProtocol} from "aws-cdk-lib/aws-sns";
import {CfnJobDefinition} from "aws-cdk-lib/aws-batch/lib/batch.generated";
import SecretProperty = CfnJobDefinition.SecretProperty;

interface Config {
    s3_backup_bucket: string;
    should_create_bucket: boolean
    backup_definitions: BackupDefinition[];
    email?: string,
}

interface BackupDefinition {
    s3_folder: string;
    google_drive_folder: string;
    google_secrets: SecretProperty[],
    schedule?: CronOptions;
}

export class GoogleBackupToS3Stack extends cdk.Stack {
    constructor(scope: Construct, id: string, config: Config, props?: cdk.StackProps) {
        super(scope, id, props);

        const snsTopic = new sns.Topic(this, "GoogleBackupToS3", {
            topicName: "GoogleBackupToS3",
        })
        if (config.email) {
            new sns.Subscription(this, "GoogleBackupToS3-SnsSubscription", {
                protocol: SubscriptionProtocol.EMAIL,
                endpoint: config.email,
                topic: snsTopic,
            })
        }
        const lambda_to_forward_batch_completion = new lambda.Function(this, 'lambda-forward-batch-completion-to-sns',
            {
                functionName: "ForwardBatchCompletionStatusToSnS",
                runtime: lambda.Runtime.PYTHON_3_9,
                handler: 'index.handler',
                code: lambda.Code.fromInline(`
import boto3, json
def handler(event, context): boto3.client("sns").publish(
    TargetArn="${snsTopic.topicArn}", 
    Message=json.dumps(event), 
    Subject="AWS Batch job for backups completed")`),
            });

        snsTopic.grantPublish(lambda_to_forward_batch_completion);
        if (config.should_create_bucket) {
            new Bucket(this, "backup-bucket", {bucketName: config.s3_backup_bucket});
        }
        const jobQueue = this.createDefaultJobQueue();
        for (let backup_def of config.backup_definitions) {
            const jobDefinition = new batch.CfnJobDefinition(
                this,
                `google-${backup_def.google_drive_folder}-backup-to-s3-job-def`,
                {
                    type: "container",
                    jobDefinitionName: `google-${backup_def.google_drive_folder}-backup-to-s3`,
                    containerProperties: {
                        command: ["/back-up-drive-folder",
                            "--s3-folder", backup_def.s3_folder, backup_def.google_drive_folder, config.s3_backup_bucket],
                        image: "pego/google-backup-to-s3:latest",
                        jobRoleArn: "arn:aws:iam::512841817041:role/google-takeout-backup-batch-execution-role",
                        executionRoleArn: "arn:aws:iam::512841817041:role/google-takeout-backup-batch-execution-role",
                        networkConfiguration: {assignPublicIp: "ENABLED",},
                        resourceRequirements: [
                            {type: "VCPU", value: "1"},
                            {type: "MEMORY", value: "2048"}
                        ],
                        secrets: backup_def.google_secrets,
                    },
                    platformCapabilities: ["FARGATE"],
                });

            new events.Rule(this, jobDefinition.jobDefinitionName + "-completed", {
                eventPattern: {
                    source: ["aws.batch"],
                    detailType: ["Batch Job State Change"],
                    detail: {
                        "status": ["FAILED", "SUCCEEDED"],
                        "jobDefinition": [jobDefinition.ref],
                    }
                },
                enabled: true,
                ruleName: jobDefinition.jobDefinitionName + "-completed",
                targets: [new targets.LambdaFunction(lambda_to_forward_batch_completion)],
            });
            if (backup_def.schedule) {
                new events.Rule(this, `run-google-${backup_def.google_drive_folder}-backup-to-s3-event-rule`, {
                    enabled: true,
                    ruleName: `run-google-${backup_def.google_drive_folder}-backup-to-s3`,
                    schedule: Schedule.cron(backup_def.schedule),
                    targets: [new BatchJob(jobQueue.attrJobQueueArn, jobQueue, jobDefinition.ref, jobDefinition,
                        {jobName: `google-${backup_def.google_drive_folder}-backup-to-s3`}
                    )],
                });
            }
        }
    }

    private createDefaultJobQueue() {
        return new batch.CfnJobQueue(this, "default-job-queue", {
            jobQueueName: "default-job-queue",
            computeEnvironmentOrder: [{
                computeEnvironment: new CfnComputeEnvironment(this, "default-compute-env", {
                    computeEnvironmentName: "default-compute-environment",
                    type: "MANAGED",
                    computeResources: {
                        type: "FARGATE",
                        maxvCpus: 256,
                        subnets: ["subnet-09651f50fbbae3a34"],
                        securityGroupIds: ["sg-0e7c9bcf25301a59b"],
                    },
                    serviceRole: `arn:aws:iam::${Stack.of(this).account}:role/aws-service-role/batch.amazonaws.com/AWSServiceRoleForBatch`,
                }).attrComputeEnvironmentArn,
                order: 0,
            }],
            priority: 0
        });
    }
}