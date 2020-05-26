/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

import * as picker from '../../shared/ui/picker'
import { MultiStepWizard, WizardStep } from '../../shared/wizards/multiStepWizard'
import { LogGroupNode } from '../explorer/logGroupNode'
import { CloudWatchLogs } from 'aws-sdk'
import { ext } from '../../shared/extensionGlobals'
import { CloudWatchLogsClient } from '../../shared/clients/cloudWatchLogsClient'
import { IteratingAWSCall } from '../../shared/utilities/collectionUtils'

export interface SelectLogStreamResponse {
    region: string
    logGroup: string
    logStream: string
}

export async function selectLogStream(node: LogGroupNode): Promise<void> {
    const logStreamResponse = await new SelectLogStreamWizard(node).run()
    if (logStreamResponse) {
        vscode.window.showInformationMessage(
            `Not implemented but here's the deets:
region: ${logStreamResponse.region}
logGroup: ${logStreamResponse.logGroup}
logStream: ${logStreamResponse.logStream}`
        )
    }
}

export interface SelectLogStreamWizardContext {
    pickLogStream(): Promise<string | undefined>
}

export class DefaultSelectLogStreamWizardContext implements SelectLogStreamWizardContext {
    public constructor(private readonly regionCode: string, private readonly logGroupName: string) {}

    public async pickLogStream(): Promise<string | undefined> {
        const quickPick = createDescribeLogStreamsCallPicker(this.regionCode, this.logGroupName)

        const choices = await quickPick.promptUser()
        const val = picker.verifySinglePickerOutput(choices)

        return val?.label
    }
}

// TODO: Cache these results?
export class IteratingAWSCallPicker<TRequest, TResponse> {
    private isDone: boolean = false
    private isPaused: boolean = false
    private items: vscode.QuickPickItem[] = []

    private readonly quickPick: vscode.QuickPick<vscode.QuickPickItem>
    private readonly moreItemsRequest: vscode.EventEmitter<void> = new vscode.EventEmitter<void>()

    /**
     * @param awsCallLogic: Object representing the call to be used, the initial request, and a function that converts from a response object to an array of quick pick items
     * @param pickerOptions: Object representing QuickPick options, additional buttons, and any additional functionality to be called upon selecting a button.
     */
    public constructor(
        private readonly awsCallLogic: {
            // TODO: allow for creation of a new call in case we want to reload quick pick in its entirety
            iteratingAwsCall: IteratingAWSCall<TRequest, TResponse>
            initialRequest: TRequest
            awsResponseToQuickPickItem: (response: TResponse) => vscode.QuickPickItem[]
        },
        private readonly pickerOptions: {
            options?: vscode.QuickPickOptions & picker.AdditionalQuickPickOptions
            buttons?: vscode.QuickInputButton[]
            onDidTriggerButton?: (
                button: vscode.QuickInputButton,
                resolve: (
                    value: vscode.QuickPickItem[] | PromiseLike<vscode.QuickPickItem[] | undefined> | undefined
                ) => void,
                reject: (reason?: any) => void
            ) => void
        } = {}
    ) {
        // TODO: Create default buttons for load next page, refresh
        // TODO: Set a global throttling flag that will optionally display said load next page button
        this.quickPick = picker.createQuickPick<vscode.QuickPickItem>({
            options: {
                ...this.pickerOptions.options,
                onDidSelectItem: item => {
                    // pause any existing execution
                    this.isPaused = true
                    // pass existing onDidSelectItem through if it exists
                    if (this.pickerOptions.options?.onDidSelectItem) {
                        this.pickerOptions.options.onDidSelectItem(item)
                    }
                },
            },
            items: this.items,
            buttons: this.pickerOptions.buttons,
        })

        this.moreItemsRequest.event(() => this.loadItems())
    }

    /**
     * Prompts the user with the quick pick specified by the constructor.
     * Always attempts to load new results from the iteratingAwsCall, even if the call has been exhausted.
     * If the call picker was previously paused, unpauses it.
     */
    public async promptUser(): Promise<vscode.QuickPickItem[] | undefined> {
        // start background loading and unpause the loader (if it was paused previously by a selection)
        this.quickPick.busy = true
        this.isPaused = false
        if (!this.isDone) {
            this.moreItemsRequest.fire()
        }
        return await picker.promptUser<vscode.QuickPickItem>({
            picker: this.quickPick,
            onDidTriggerButton: this.pickerOptions.onDidTriggerButton,
        })
    }

    // TODO: Add nodes for no items, error (error retries call from where it left off?)
    private async loadItems(): Promise<void> {
        const iter = this.awsCallLogic.iteratingAwsCall.getIteratorForRequest(this.awsCallLogic.initialRequest)

        for await (const item of iter) {
            if (!this.isDone && !this.isPaused) {
                this.items = this.items.concat(this.awsCallLogic.awsResponseToQuickPickItem(item))
                // TODO: Is there a way to append to this ReadOnlyArray so it doesn't constantly pop focus back to the top?
                this.quickPick.items = this.items
            } else {
                break
            }
        }
        this.isDone = true
        this.quickPick.busy = false
    }
}

function createDescribeLogStreamsCallPicker(
    regionCode: string,
    logGroupName: string
): IteratingAWSCallPicker<CloudWatchLogs.DescribeLogStreamsRequest, CloudWatchLogs.DescribeLogStreamsResponse> {
    const client: CloudWatchLogsClient = ext.toolkitClientBuilder.createCloudWatchLogsClient(regionCode)

    return new IteratingAWSCallPicker(
        {
            iteratingAwsCall: new IteratingAWSCall(client.describeLogStreams.bind(client), {
                request: 'nextToken',
                response: 'nextToken',
            }),
            initialRequest: {
                logGroupName,
                orderBy: 'LastEventTime',
                descending: true,
                limit: 1, // TODO: remove, for testing purposes
            },
            awsResponseToQuickPickItem: (response: CloudWatchLogs.DescribeLogStreamsResponse) => {
                const result: vscode.QuickPickItem[] = []

                if (response.logStreams) {
                    for (const stream of response.logStreams) {
                        result.push({
                            label: stream.logStreamName!,
                            detail: stream.lastEventTimestamp
                                ? new Date(stream.lastEventTimestamp).toString()
                                : '(Log Stream has no events)',
                        })
                    }
                }

                return result
            },
        },
        {
            options: {
                title: localize('aws.cloudWatchLogs.selectLogStream.workflow.prompt', 'Select a log stream'),
                matchOnDetail: true,
                ignoreFocusOut: true, // TODO: remove, present for testing purposes
            },
        }
    )
}

export class SelectLogStreamWizard extends MultiStepWizard<SelectLogStreamResponse> {
    private readonly response: Partial<SelectLogStreamResponse>

    public constructor(
        node: LogGroupNode,
        private readonly context: SelectLogStreamWizardContext = new DefaultSelectLogStreamWizardContext(
            node.regionCode,
            node.logGroup.logGroupName!
        )
    ) {
        super()
        this.response = {
            region: node.regionCode,
            logGroup: node.logGroup.arn,
        }
    }

    protected get startStep(): WizardStep {
        return this.SELECT_STREAM
    }

    protected getResult(): SelectLogStreamResponse | undefined {
        if (!this.response.region || !this.response.logGroup || !this.response.logStream) {
            return undefined
        }

        return {
            region: this.response.region,
            logGroup: this.response.logGroup,
            logStream: this.response.logStream,
        }
    }

    private readonly SELECT_STREAM: WizardStep = async () => {
        this.response.logStream = await this.context.pickLogStream()

        return undefined
    }
}
