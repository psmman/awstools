/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as nls from 'vscode-nls'
import * as moment from 'moment'
const localize = nls.loadMessageBundle()

import * as picker from '../../shared/ui/picker'
import { MultiStepWizard, WizardStep } from '../../shared/wizards/multiStepWizard'
import { LogGroupNode } from '../explorer/logGroupNode'
import { CloudWatchLogs } from 'aws-sdk'
import { ext } from '../../shared/extensionGlobals'
import { CloudWatchLogsClient } from '../../shared/clients/cloudWatchLogsClient'
import * as telemetry from '../../shared/telemetry/telemetry'
import { LOCALIZED_DATE_FORMAT } from '../../shared/constants'
import { getPaginatedAwsCallIter, IteratorTransformer } from '../../shared/utilities/collectionUtils'

export interface SelectLogStreamResponse {
    region: string
    logGroupName: string
    logStreamName: string
}

export async function viewLogStream(node: LogGroupNode): Promise<void> {
    let result: telemetry.Result = 'Succeeded'
    const logStreamResponse = await new SelectLogStreamWizard(node).run()
    if (logStreamResponse) {
        vscode.window.showInformationMessage(
            `Not implemented but here's the deets:
region: ${logStreamResponse.region}
logGroup: ${logStreamResponse.logGroupName}
logStream: ${logStreamResponse.logStreamName}`
        )
    } else {
        result = 'Cancelled'
    }

    telemetry.recordCloudwatchlogsOpenStream({ result })
}

export interface SelectLogStreamWizardContext {
    pickLogStream(): Promise<string | undefined>
}

export class DefaultSelectLogStreamWizardContext implements SelectLogStreamWizardContext {
    public constructor(private readonly regionCode: string, private readonly logGroupName: string) {}

    public async pickLogStream(): Promise<string | undefined> {
        let telemetryResult: telemetry.Result = 'Succeeded'

        const client: CloudWatchLogsClient = ext.toolkitClientBuilder.createCloudWatchLogsClient(this.regionCode)
        const request: CloudWatchLogs.DescribeLogStreamsRequest = {
            logGroupName: this.logGroupName,
            orderBy: 'LastEventTime',
            descending: true,
        }
        const qp = picker.createQuickPick({})
        const populator = new IteratorTransformer(
            () =>
                getPaginatedAwsCallIter({
                    awsCall: request => client.describeLogStreams(request),
                    nextTokenNames: {
                        request: 'nextToken',
                        response: 'nextToken',
                    },
                    request,
                }),
            response => convertDescribeLogStreamsToQuickPickItems(response)
        )

        const controller = new picker.IteratingQuickPickController(qp, populator)
        controller.startRequests()
        const choices = await picker.promptUser({
            picker: qp,
            onDidTriggerButton: (button, resolve, reject) =>
                controller.iteratingOnDidTriggerButton(button, resolve, reject),
        })

        const val = picker.verifySinglePickerOutput(choices)

        let result = val?.label

        // handle no items for a group as a cancel
        if (!result || result === picker.IteratingQuickPickController.NO_ITEMS_ITEM.label) {
            result = undefined
            telemetryResult = 'Cancelled'
        }
        // retry handled by caller -- should this be a "Failed"?
        // of note: we don't track if an error pops up, we just track if the error is selected.
        if (result === picker.IteratingQuickPickController.ERROR_ITEM.label) {
            telemetryResult = 'Failed'
        }

        telemetry.recordCloudwatchlogsOpenGroup({ result: telemetryResult })
        return result
    }
}

export function convertDescribeLogStreamsToQuickPickItems(
    response: CloudWatchLogs.DescribeLogStreamsResponse
): vscode.QuickPickItem[] {
    return (response.logStreams ?? []).map<vscode.QuickPickItem>(stream => ({
        label: stream.logStreamName!,
        detail: stream.lastEventTimestamp
            ? moment(stream.lastEventTimestamp).format(LOCALIZED_DATE_FORMAT)
            : localize('aws.cloudWatchLogs.viewLogStream.workflow.noStreams', '[No Log Events found]'),
    }))
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
            logGroupName: node.logGroup.logGroupName,
        }
    }

    protected get startStep(): WizardStep {
        return this.SELECT_STREAM
    }

    protected getResult(): SelectLogStreamResponse | undefined {
        if (!this.response.region || !this.response.logGroupName || !this.response.logStreamName) {
            return undefined
        }

        return {
            region: this.response.region,
            logGroupName: this.response.logGroupName,
            logStreamName: this.response.logStreamName,
        }
    }

    private readonly SELECT_STREAM: WizardStep = async () => {
        const returnVal = await this.context.pickLogStream()

        // retry on error
        if (returnVal === picker.IteratingQuickPickController.ERROR_ITEM.label) {
            return this.SELECT_STREAM
        }

        this.response.logStreamName = returnVal

        return undefined
    }
}
