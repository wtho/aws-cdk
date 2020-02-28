import * as path from 'path';
import { DockerImageManifestEntry } from '../../asset-manifest';
import { EventType } from '../../progress';
import { IAssetHandler, IHandlerHost } from "../asset-handler";
import { Docker } from "../docker";
import { replaceAwsPlaceholders } from "../placeholders";

export class ContainerImageAssetHandler implements IAssetHandler {
  private readonly localTagName: string;
  private readonly docker = new Docker(m => this.host.emitMessage(EventType.DEBUG, m));

  constructor(
    private readonly workDir: string,
    private readonly asset: DockerImageManifestEntry,
    private readonly host: IHandlerHost) {

    this.localTagName = `cdkasset-${this.asset.id.assetId.toLowerCase()}`;
  }

  public async publish(): Promise<void> {
    const destination = await replaceAwsPlaceholders(this.asset.destination, this.host.aws);

    const ecr = await this.host.aws.ecrClient(destination);

    const uri = await repositoryUri(ecr, destination.repositoryName);
    if (!uri) {
      throw new Error(`No ECR repository with name '${destination.repositoryName}' in account. Is this account bootstrapped?`);
    }

    this.host.emitMessage(EventType.CHECK, `Check ${uri}`);
    if (await imageExists(ecr, destination.repositoryName, destination.imageTag)) {
      this.host.emitMessage(EventType.FOUND, `Found ${uri}`);
      return;
    }

    if (this.host.aborted) { return; }
    await this.buildImage();

    this.host.emitMessage(EventType.UPLOAD, `Push ${uri}`);
    if (this.host.aborted) { return; }
    await this.docker.tag(this.localTagName, uri);
    await this.docker.login(ecr);
    await this.docker.push(uri);
  }

  private async buildImage(): Promise<void> {
    if (await this.docker.exists(this.localTagName)) {
      this.host.emitMessage(EventType.CACHED, `Cached ${this.localTagName}`);
      return;
    }

    const source = this.asset.source;

    const fullPath = path.join(this.workDir, source.directory);
    this.host.emitMessage(EventType.BUILD, `Building Docker image at ${fullPath}`);

    await this.docker.build({
      directory: fullPath,
      tag: this.localTagName,
      buildArgs: source.dockerBuildArgs,
      target: source.dockerBuildTarget,
      file: source.dockerFile,
    });
  }
}

async function imageExists(ecr: AWS.ECR, repositoryName: string, imageTag: string) {
  try {
    await ecr.describeImages({ repositoryName, imageIds: [{ imageTag }] }).promise();
    return true;
  } catch (e) {
    if (e.code !== 'ImageNotFoundException') { throw e; }
    return false;
  }
}

/**
 * Return the URI for the repository with the given name
 *
 * Returns undefined if the repository does not exist.
 */
async function repositoryUri(ecr: AWS.ECR, repositoryName: string): Promise<string | undefined> {
  try {
    const response = await ecr.describeRepositories({ repositoryNames: [repositoryName] }).promise();
    return (response.repositories || [])[0]?.repositoryUri;
  } catch (e) {
    if (e.code !== 'RepositoryNotFoundException') { throw e; }
    return undefined;
  }
}