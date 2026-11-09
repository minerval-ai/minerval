import * as cdk from "aws-cdk-lib";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

export interface DatabaseStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  dbSg: ec2.SecurityGroup;
}

export class DatabaseStack extends cdk.Stack {
  public readonly dbInstance: rds.DatabaseInstance;
  public readonly dbSecret: rds.DatabaseSecret;
  /**
   * Read-only SQL over the public views (src/services/sql-service.ts) runs
   * on a read replica, so a heavy query from an agent or an outside caller
   * can never slow the primary the graph writes to. Roles replicate with
   * the data, so the login roles below exist on it once created on the
   * primary (scripts/ensure-sql-roles.ts).
   */
  public readonly readReplica: rds.DatabaseInstanceReadReplica;
  /** Login role for agents' queries: member of minerval_sql, views only. */
  public readonly sqlAgentSecret: rds.DatabaseSecret;
  /** Login role for outside callers' queries: the same grants, its own connection limit. */
  public readonly sqlCallerSecret: rds.DatabaseSecret;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    this.dbSecret = new rds.DatabaseSecret(this, "EpistemeDbSecret", {
      username: "episteme",
    });

    this.dbInstance = new rds.DatabaseInstance(this, "EpistemeDb", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO
      ),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.dbSg],
      credentials: rds.Credentials.fromSecret(this.dbSecret),
      databaseName: "episteme",
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      backupRetention: cdk.Duration.days(7),
    });

    this.readReplica = new rds.DatabaseInstanceReadReplica(this, "EpistemeDbReadReplica", {
      sourceDatabaseInstance: this.dbInstance,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.dbSg],
      storageType: rds.StorageType.GP3,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.sqlAgentSecret = new rds.DatabaseSecret(this, "SqlAgentDbSecret", {
      username: "minerval_sql_agent",
      excludeCharacters: " %+~`#$&*()|[]{}:;<>?!'/@\"\\",
    });
    this.sqlCallerSecret = new rds.DatabaseSecret(this, "SqlCallerDbSecret", {
      username: "minerval_sql_caller",
      excludeCharacters: " %+~`#$&*()|[]{}:;<>?!'/@\"\\",
    });
  }
}
