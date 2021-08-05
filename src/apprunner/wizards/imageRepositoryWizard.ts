/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { AppRunner, IAM } from 'aws-sdk'
import {
    createBackButton,
    createExitButton,
    createHelpButton,
    QuickInputButton,
    QuickInputToggleButton,
} from '../../shared/ui/buttons'
import { toArrayAsync } from '../../shared/utilities/collectionUtils'
import { EcrClient, EcrRepository } from '../../shared/clients/ecrClient'
import * as input from '../../shared/ui/inputPrompter'
import * as picker from '../../shared/ui/pickerPrompter'
import { Prompter } from '../../shared/ui/prompter'
import { Wizard, WizardControl } from '../../shared/wizards/wizard'
import { WizardPrompter } from '../../shared/ui/wizardPrompter'

import * as nls from 'vscode-nls'
import { WizardForm } from '../../shared/wizards/wizardForm'
import { createVariablesPrompter } from '../../shared/ui/common/variablesPrompter'
import { makeDeploymentButton } from './apprunnerCreateServiceWizard'
import { IamClient } from '../../shared/clients/iamClient'
import { RolePrompter } from '../../shared/ui/common/rolePrompter'

const localize = nls.loadMessageBundle()

function makeButtons() {
    return [
        createHelpButton('https://docs.aws.amazon.com/toolkit-for-vscode/latest/userguide/welcome.html'),
        createBackButton(),
        createExitButton(),
    ]
}

const PUBLIC_ECR = 'public.ecr.aws'

export type TaggedEcrRepository = EcrRepository & { tag?: string }

interface ImagePrompterOptions {
    noPublicMessage?: string
    extraButtons?: QuickInputButton<void | WizardControl>
}

function createEcrRole(client: IamClient): Promise<IAM.Role> {
    const policy = {
        Version: '2008-10-17',
        Statement: [
            {
                Sid: '',
                Effect: 'Allow',
                Principal: {
                    Service: ['build.apprunner.amazonaws.com'],
                },
                Action: 'sts:AssumeRole',
            },
        ],
    }
    const ecrPolicy = 'arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess'

    return client
        .createRole({
            RoleName: `AppRunnerECRAccessRole${Math.floor(Math.random() * 1000000000) + 1000}`,
            AssumeRolePolicyDocument: JSON.stringify(policy),
        })
        .then(resp => {
            const role = resp.Role
            return client.attachRolePolicy({ RoleName: role.RoleName, PolicyArn: ecrPolicy }).then(() => role)
        })
}

function createImagePrompter(
    ecrClient: EcrClient,
    cache: { [key: string]: any },
    options: ImagePrompterOptions = {}
): picker.QuickPickPrompter<TaggedEcrRepository> {
    const last = cache['repos']
    const imageRepos =
        last ??
        toArrayAsync(ecrClient.describeRepositories()).then(resp => {
            const repos = resp.map(repo => ({ label: repo.repositoryName, detail: repo.repositoryUri, data: repo }))
            cache['repos'] = repos
            return repos
        })
    const customUserInputLabel = localize('AWS.apprunner.createService.selectImageRepo.input', 'Custom ECR URL')
    const customUserInputTransform = (resp: string) => {
        const userInputParts = resp.split(':')

        return {
            repositoryArn: '',
            repositoryName: 'UserDefined',
            repositoryUri: userInputParts[0],
            tag: userInputParts[1]?.trim() ?? 'latest',
        }
    }

    const ecrUriValidator = (input: string) => {
        const userInputParts = input.split(':')

        if (userInputParts.length > 2) {
            return 'colon should be used to delimit tag'
        }

        if (userInputParts.length === 2 && userInputParts[1].trim() === '') {
            return 'tag cannot be empty'
        }

        const privateRegExp = /[0-9]+\.dkr\.ecr\.[a-zA-z0-9\-]+\.amazonaws\.com/

        if (options.noPublicMessage && userInputParts[0].startsWith(PUBLIC_ECR)) {
            return options.noPublicMessage
        }

        if (!userInputParts[0].startsWith(PUBLIC_ECR) && !userInputParts[0].match(privateRegExp)) {
            return 'not a valid ECR URL'
        }
    }

    const customUserInputValidator = (input: string) => {
        const message = ecrUriValidator(input)
        return message !== undefined ? `$(close) Invalid input: ${message}` : undefined
    }

    return picker.createQuickPick<TaggedEcrRepository>(imageRepos, {
        title: localize('AWS.apprunner.createService.selectImageRepo.title', 'Select or enter an image repository'),
        placeholder: '123456789012.dkr.ecr.us-east-1.amazonaws.com/myrepo:latest',
        filterBoxInputSettings: {
            label: customUserInputLabel,
            transform: customUserInputTransform,
            validator: customUserInputValidator,
        },
        buttons: makeButtons(),
    })
}

function createPortPrompter(): Prompter<string> {
    const validatePort = (port: string) => {
        if (isNaN(Number(port)) || port === '') {
            return localize('AWS.apprunner.createService.selectPort.invalidPort', 'Port must be a number')
        }

        return undefined
    }

    return input.createInputBox({
        validateInput: validatePort,
        title: localize('AWS.apprunner.createService.selectPort.title', 'Enter a port for the new service'),
        placeholder: 'Enter a port',
        buttons: makeButtons(),
    })
}

function createTagPrompter(
    ecrClient: EcrClient,
    imageRepo: EcrRepository,
    cache: { [key: string]: any }
): picker.QuickPickPrompter<string> {
    const last: picker.DataQuickPickItem<TaggedEcrRepository>[] = cache[imageRepo.repositoryName]
    const tagItems =
        last ??
        toArrayAsync(ecrClient.describeTags(imageRepo.repositoryName)).then(tags => {
            const tagT = tags.map(tag => ({ label: tag }))
            cache[imageRepo.repositoryName] = tagT
            return tagT
        })

    return picker.createLabelQuickPick(tagItems, {
        title: localize('AWS.apprunner.createService.selectTag.title', 'Select an ECR tag'),
        placeholder: 'latest',
        buttons: makeButtons(),
    })
}

export class ImageIdentifierForm extends WizardForm<{ repo: TaggedEcrRepository }> {
    constructor(ecrClient: EcrClient, options: ImagePrompterOptions = {}) {
        super()

        this.body.repo.bindPrompter(state => createImagePrompter(ecrClient, state.stepCache, options))
        this.body.repo.tag.bindPrompter(state => createTagPrompter(ecrClient, state.repo!, state.stepCache), {
            requireParent: true,
        })
    }
}

function createImageRepositorySubForm(
    ecrClient: EcrClient,
    autoDeployButton: QuickInputToggleButton
): WizardForm<AppRunner.ImageRepository> {
    const subform = new WizardForm<AppRunner.ImageRepository>()
    const form = subform.body

    // note: this is intentionally initialized only once to preserve caches
    const imageIdentifierWizard = new Wizard({
        initForm: new ImageIdentifierForm(ecrClient),
    })

    form.ImageIdentifier.bindPrompter(() =>
        new WizardPrompter(imageIdentifierWizard).transform(resp => `${resp.repo.repositoryUri}:${resp.repo.tag}`)
    )

    function isPublic(imageRepo: string): boolean {
        return imageRepo.search(/^public.ecr.aws/) !== -1
    }

    form.ImageRepositoryType.setDefault(state =>
        state.ImageIdentifier !== undefined ? (isPublic(state.ImageIdentifier) ? 'ECR_PUBLIC' : 'ECR') : undefined
    )

    form.ImageConfiguration.Port.bindPrompter(() => createPortPrompter())
    form.ImageConfiguration.RuntimeEnvironmentVariables.bindPrompter(() => createVariablesPrompter(makeButtons()))

    return subform
}

export type ImageRepositorySource = AppRunner.SourceConfiguration
export class AppRunnerImageRepositoryForm extends WizardForm<ImageRepositorySource> {
    constructor(ecrClient: EcrClient, iamClient: IamClient, autoDeployButton = makeDeploymentButton()) {
        super()
        const form = this.body
        const rolePrompter = new RolePrompter(iamClient, {
            title: localize('AWS.apprunner.createService.selectRole.title', 'Select a role to pull from ECR'),
            filter: role => (role.AssumeRolePolicyDocument ?? '').includes('build.apprunner.amazonaws.com'),
            createRole: createEcrRole.bind(undefined, iamClient),
        })

        form.ImageRepository.applyForm(createImageRepositorySubForm(ecrClient, autoDeployButton))
        form.AuthenticationConfiguration.AccessRoleArn.bindPrompter(
            rolePrompter.transform(resp => resp.Arn),
            {
                showWhen: form => form.ImageRepository?.ImageRepositoryType === 'ECR',
            }
        )
        form.AutoDeploymentsEnabled.setDefault(() => autoDeployButton.state === 'on')
    }
}
