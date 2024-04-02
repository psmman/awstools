/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as nls from 'vscode-nls'
import * as fs from 'fs'
import * as os from 'os'
import { getLogger } from '../../shared/logger'
import * as CodeWhispererConstants from '../models/constants'
import {
    transformByQState,
    StepProgress,
    TransformByQReviewStatus,
    JDKVersion,
    sessionPlanProgress,
    FolderInfo,
    TransformationCandidateProject,
    TransformByQStatus,
} from '../models/model'
import { convertToTimeString, convertDateToTimestamp, getStringHash } from '../../shared/utilities/textUtilities'
import {
    startJob,
    stopJob,
    uploadPayload,
    getTransformationPlan,
    zipCode,
    pollTransformationJob,
    throwIfCancelled,
    getArtifactIdentifiers,
    getTransformationStepsFixture,
    downloadResultArchive,
} from '../service/transformByQ/transformApiHandler'
import { getOpenProjects, validateOpenProjects } from '../service/transformByQ/transformProjectValidationHandler'
import { getVersionData, prepareProjectDependencies, runMavenDependencyBuildCommands, runMavenDependencyUpdateCommands } from '../service/transformByQ/transformMavenHandler'
import path from 'path'
import { sleep } from '../../shared/utilities/timeoutUtils'
import { encodeHTML } from '../../shared/utilities/textUtilities'
import {
    CodeTransformCancelSrcComponents,
    CodeTransformJavaSourceVersionsAllowed,
    CodeTransformJavaTargetVersionsAllowed,
    telemetry,
} from '../../shared/telemetry/telemetry'
import { codeTransformTelemetryState } from '../../amazonqGumby/telemetry/codeTransformTelemetryState'
import {
    CancelActionPositions,
    JDKToTelemetryValue,
    calculateTotalLatency,
    telemetryUndefined,
} from '../../amazonqGumby/telemetry/codeTransformTelemetry'
import { MetadataResult } from '../../shared/telemetry/telemetryClient'
import { submitFeedback } from '../../feedback/vue/submitFeedback'
import { placeholder } from '../../shared/vscode/commands2'
import { JavaHomeNotSetError } from '../../amazonqGumby/errors'
import { ChatSessionManager } from '../../amazonqGumby/chat/storages/chatSession'
import { createPomCopy, getDependenciesFolderInfo, getJsonValuesFromManifestFile, highlightPomIssueInProject, parseXmlDependenciesReport, replacePomVersion, writeLogs } from '../service/transformByQ/transformFileHandler'

const localize = nls.loadMessageBundle()
export const stopTransformByQButton = localize('aws.codewhisperer.stop.transform.by.q', 'Stop')

let sessionJobHistory: { timestamp: string; module: string; status: string; duration: string; id: string }[] = []

export async function startTransformByQWithProgress() {
    await startTransformByQ()
}

export async function processTransformFormInput(
    pathToProject: string,
    fromJDKVersion: JDKVersion,
    toJDKVersion: JDKVersion
) {
    transformByQState.setProjectName(path.basename(pathToProject))
    transformByQState.setProjectPath(pathToProject)
    transformByQState.setSourceJDKVersion(fromJDKVersion)
    transformByQState.setTargetJDKVersion(toJDKVersion)
}

async function setMaven() {
    let mavenWrapperExecutableName = os.platform() === 'win32' ? 'mvnw.cmd' : 'mvnw'
    const mavenWrapperExecutablePath = path.join(transformByQState.getProjectPath(), mavenWrapperExecutableName)
    if (fs.existsSync(mavenWrapperExecutablePath)) {
        if (mavenWrapperExecutableName === 'mvnw') {
            mavenWrapperExecutableName = './mvnw' // add the './' for non-Windows
        } else if (mavenWrapperExecutableName === 'mvnw.cmd') {
            mavenWrapperExecutableName = '.\\mvnw.cmd' // add the '.\' for Windows
        }
        transformByQState.setMavenName(mavenWrapperExecutableName)
    } else {
        transformByQState.setMavenName('mvn')
    }
    getLogger().info(`CodeTransformation: using Maven ${transformByQState.getMavenName()}`)
}

async function validateJavaHome(): Promise<boolean> {
    const versionData = await getVersionData()
    let javaVersionUsedByMaven = versionData[1]
    if (javaVersionUsedByMaven !== undefined) {
        javaVersionUsedByMaven = javaVersionUsedByMaven.slice(0, 3)
        if (javaVersionUsedByMaven === '1.8') {
            javaVersionUsedByMaven = JDKVersion.JDK8
        } else if (javaVersionUsedByMaven === '11.') {
            javaVersionUsedByMaven = JDKVersion.JDK11
        }
    }
    if (javaVersionUsedByMaven !== transformByQState.getSourceJDKVersion()) {
        telemetry.codeTransform_isDoubleClickedToTriggerInvalidProject.emit({
            codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
            codeTransformPreValidationError: 'ProjectJDKDiffersFromMavenJDK',
            result: MetadataResult.Fail,
            reason: `${transformByQState.getSourceJDKVersion()} (project) - ${javaVersionUsedByMaven} (maven)`,
        })

        // means either javaVersionUsedByMaven is undefined or it does not match the project JDK
        return false
    }

    return true
}

export async function validateCanCompileProject() {
    await setMaven()
    const javaHomeFound = await validateJavaHome()
    if (!javaHomeFound) {
        throw new JavaHomeNotSetError()
    }
}

export async function compileProject() {
    try {
        const dependenciesFolder: FolderInfo = getDependenciesFolderInfo()
        transformByQState.setDependencyFolderInfo(dependenciesFolder)
        await prepareProjectDependencies(dependenciesFolder)
    } catch (err) {
        // open build-logs.txt file to show user error logs
        const logFilePath = await writeLogs()
        const doc = await vscode.workspace.openTextDocument(logFilePath)
        await vscode.window.showTextDocument(doc)
        throw err
    }
}

export async function startTransformByQ() {
    let intervalId = undefined
    // Set the default state variables for our store and the UI
    await setTransformationToRunningState()

    await completeHumanInTheLoopWork('fake-job-id', 0)
    await postTransformationJob()
    await cleanupTransformationJob(intervalId)

    const quickExit = true
    if (quickExit) {
        return
    }

    try {
        // Set web view UI to poll for progress
        intervalId = setInterval(() => {
            void vscode.commands.executeCommand(
                'aws.amazonq.showPlanProgressInHub',
                codeTransformTelemetryState.getStartTime()
            )
        }, CodeWhispererConstants.transformationJobPollingIntervalSeconds * 1000)

        // step 1: CreateCodeUploadUrl and upload code
        const uploadId = await preTransformationUploadCode()

        // step 2: StartJob and store the returned jobId in TransformByQState
        const jobId = await startTransformationJob(uploadId)

        // step 3 (intermediate step): show transformation-plan.md file
        await pollTransformationStatusUntilPlanReady(jobId)

        // step 4: poll until artifacts are ready to download
        const status = await pollTransformationStatusUntilComplete(jobId, 0)

        // Set the result state variables for our store and the UI
        // At this point job should be completed or partially completed
        await finalizeTransformationJob(status)
    } catch (error: any) {
        await transformationJobErrorHandler(error)
    } finally {
        await postTransformationJob()
        await cleanupTransformationJob(intervalId)
    }
}

export async function preTransformationUploadCode() {
    await vscode.commands.executeCommand('aws.amazonq.refresh')
    await vscode.commands.executeCommand('aws.amazonq.transformationHub.focus')

    let uploadId = ''
    let payloadFilePath = ''
    throwIfCancelled()
    try {
        payloadFilePath = await zipCode(transformByQState.getDependencyFolderInfo()!)
        transformByQState.setPayloadFilePath(payloadFilePath)
        uploadId = await uploadPayload(payloadFilePath)
    } catch (err) {
        const errorMessage = `Failed to upload code due to ${(err as Error).message}`
        getLogger().error(errorMessage)
        telemetry.codeTransform_logGeneralError.emit({
            codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
            codeTransformApiErrorMessage: errorMessage,
            result: MetadataResult.Fail,
            reason: 'UploadArchiveFailed',
        })
        throw err
    }

    await sleep(2000) // sleep before starting job to prevent ThrottlingException
    throwIfCancelled()

    return uploadId
}

export async function startTransformationJob(uploadId: string) {
    let jobId = ''
    try {
        jobId = await startJob(uploadId)
    } catch (error) {
        const errorMessage = CodeWhispererConstants.failedToStartJobMessage
        telemetry.codeTransform_logGeneralError.emit({
            codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
            codeTransformApiErrorMessage: errorMessage,
            result: MetadataResult.Fail,
            reason: 'StartJobFailed',
        })
        transformByQState.setJobFailureErrorMessage(errorMessage)
        throw new Error('Start job failed')
    }
    transformByQState.setJobId(encodeHTML(jobId))
    await vscode.commands.executeCommand('aws.amazonq.refresh')

    await sleep(2000) // sleep before polling job to prevent ThrottlingException
    throwIfCancelled()

    return jobId
}

export async function pollTransformationStatusUntilPlanReady(jobId: string) {
    try {
        await pollTransformationJob(jobId, CodeWhispererConstants.validStatesForPlanGenerated)
    } catch (error) {
        const errorMessage = CodeWhispererConstants.failedToCompleteJobMessage
        getLogger().error(`CodeTransformation: ${errorMessage}`, error)
        transformByQState.setJobFailureErrorMessage(errorMessage)
        throw new Error('Poll job failed')
    }
    let plan = undefined
    try {
        plan = await getTransformationPlan(jobId)
    } catch (error) {
        const errorMessage = CodeWhispererConstants.failedToCompleteJobMessage
        getLogger().error(`CodeTransformation: ${errorMessage}`, error)
        transformByQState.setJobFailureErrorMessage(errorMessage)
        throw new Error('Get plan failed')
    }

    const planFilePath = path.join(os.tmpdir(), 'transformation-plan.md')
    fs.writeFileSync(planFilePath, plan)
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(planFilePath))
    transformByQState.setPlanFilePath(planFilePath)
    await vscode.commands.executeCommand('setContext', 'gumby.isPlanAvailable', true)
    throwIfCancelled()
}

export async function pollTransformationStatusUntilComplete(jobId: string, userInputRetryCount: number) {
    let status = ''
    try {
        status = await pollTransformationJob(jobId, CodeWhispererConstants.validStatesForCheckingDownloadUrl)
    } catch (error) {
        const errorMessage = CodeWhispererConstants.failedToCompleteJobMessage
        getLogger().error(`CodeTransformation: ${errorMessage}`, error)
        transformByQState.setJobFailureErrorMessage(errorMessage)
        throw new Error('Poll job failed')
    }

    // Use recursion here to get user input
    if (
        status === TransformByQStatus.WaitingUserInput &&
        userInputRetryCount > CodeWhispererConstants.maxHumanInTheLoopAttempts
    ) {
        try {
            userInputRetryCount++

            // 8) Once all this is successful we need to re-initiate pollTransformationStatusUntilComplete
            await completeHumanInTheLoopWork(jobId, userInputRetryCount)
            status = await pollTransformationStatusUntilComplete(jobId, userInputRetryCount)
        } catch (e) {
            // do nothing for now. If a recursive call failed, need to set status appropriately?
            // or throw error
        }
    }

    return status
}

export async function completeHumanInTheLoopWork(jobId: string, userInputRetryCount: number) {
    console.log('Entering completeHumanInTheLoopWork', jobId, userInputRetryCount)

    const pomReplacementDelimiter = '*****'
    const localPathToXmlDependencyList = '/target/dependency-updates-aggregate-report.xml'

    const osTmpDir = os.tmpdir()
    const tmpDependencyListFolderName = 'q-pom-dependency-list'
    const userDependencyUpdateFolderName = 'q-pom-dependency-update'
    const tmpDependencyListDir = path.join(osTmpDir, tmpDependencyListFolderName)
    const userDependencyUpdateDir = path.join(osTmpDir, userDependencyUpdateFolderName)

    try {
        // 1) We need to call GetTransformationPlan to get artifactId
        const transformationSteps = await getTransformationStepsFixture(jobId)
        const { artifactId, artifactType } = getArtifactIdentifiers(transformationSteps)

        // 2) We need to call DownloadResultArchive to get the manifest and pom.xml
        const { pomFileVirtualFileReference, manifestFileVirtualFileReference } = await downloadResultArchive(
            jobId,
            artifactId,
            artifactType
        )
        const manifestFileValues = await getJsonValuesFromManifestFile(manifestFileVirtualFileReference)

        // 3) We need to replace version in pom.xml
        const newPomFileVirtualFileReference = await createPomCopy(
            tmpDependencyListDir,
            pomFileVirtualFileReference,
            'pom.xml'
        )
        await replacePomVersion(
            newPomFileVirtualFileReference,
            manifestFileValues.sourcePomVersion,
            pomReplacementDelimiter
        )
        await highlightPomIssueInProject(newPomFileVirtualFileReference, manifestFileValues.sourcePomVersion)

        // 4) We need to run maven commands on that pom.xml to get available versions
        const compileFolderInfo: FolderInfo = {
            name: tmpDependencyListFolderName,
            path: tmpDependencyListDir,
        }
        runMavenDependencyUpdateCommands(compileFolderInfo)
        const { latestVersion, majorVersions, minorVersions } = await parseXmlDependenciesReport(
            path.join(tmpDependencyListDir, localPathToXmlDependencyList)
        )
        console.log(latestVersion, majorVersions, minorVersions)

        // 5) We need to wait for user input
        // transformByQState.getChatControllers()?.humanInTheLoopIntervention.fire({
        //     latestVersion,
        //     tabID: ChatSessionManager.Instance.getSession().tabID,
        // })
        const getUserInputValue = latestVersion

        // 6) We need to add user input to that pom.xml,
        // original pom.xml is intact somewhere, and run maven compile
        const userInputPomFileVirtualFileReference = await createPomCopy(
            userDependencyUpdateDir,
            pomFileVirtualFileReference,
            'pom.xml'
        )
        await replacePomVersion(userInputPomFileVirtualFileReference, getUserInputValue, pomReplacementDelimiter)

        // 7) We need to take that output of maven and use CreateUploadUrl
        const uploadFolderInfo: FolderInfo = {
            name: userDependencyUpdateFolderName,
            path: userDependencyUpdateDir,
        }
        runMavenDependencyBuildCommands(uploadFolderInfo)
        // TODO modify code to be re-usable with current framework here
        // TODO Update manifest.json file for upload
        const uploadPayloadFilePath = await zipCode(uploadFolderInfo)
        const uploadId = await uploadPayload(uploadPayloadFilePath)
        console.log('Finished human in the loop work', uploadId)
    } catch (err) {
        // Will probably emit different TYPES of errors from the Human in the loop engagement
        // catch them here and determine what to do with in parent function
        console.log('Error in completeHumanInTheLoopWork', err)
    } finally {
        // 1) TODO Always delete items off disk manifest.json and pom.xml

        // Always delete the dependency output
        console.log('Deleting temporary dependency output', tmpDependencyListDir)
        fs.rmdirSync(tmpDependencyListDir, { recursive: true })
        console.log('Deleting temporary dependency output', userDependencyUpdateDir)
        fs.rmdirSync(userDependencyUpdateDir, { recursive: true })
    }
}

export async function finalizeTransformationJob(status: string) {
    if (!(status === 'COMPLETED' || status === 'PARTIALLY_COMPLETED')) {
        const errorMessage = CodeWhispererConstants.failedToCompleteJobMessage
        getLogger().error(`CodeTransformation: ${errorMessage}`)
        sessionPlanProgress['transformCode'] = StepProgress.Failed
        transformByQState.setJobFailureErrorMessage(errorMessage)
        throw new Error('Job was not successful nor partially successful')
    }

    transformByQState.setToSucceeded()
    if (status === 'PARTIALLY_COMPLETED') {
        transformByQState.setToPartiallySucceeded()
        codeTransformTelemetryState.setResultStatus('JobPartiallySucceeded')
    } else {
        codeTransformTelemetryState.setResultStatus('JobCompletedSuccessfully')
    }

    await vscode.commands.executeCommand('aws.amazonq.transformationHub.reviewChanges.reveal')
    await vscode.commands.executeCommand('aws.amazonq.refresh')

    sessionPlanProgress['transformCode'] = StepProgress.Succeeded
}

export async function getValidCandidateProjects(): Promise<TransformationCandidateProject[]> {
    const openProjects = await getOpenProjects()
    return validateOpenProjects(openProjects)
}

export async function setTransformationToRunningState() {
    await setContextVariables()

    transformByQState.setToRunning()
    sessionPlanProgress['startJob'] = StepProgress.Pending
    sessionPlanProgress['buildCode'] = StepProgress.Pending
    sessionPlanProgress['generatePlan'] = StepProgress.Pending
    sessionPlanProgress['transformCode'] = StepProgress.Pending

    codeTransformTelemetryState.setStartTime()

    const projectPath = transformByQState.getProjectPath()
    let projectId = telemetryUndefined
    if (projectPath !== undefined) {
        projectId = getStringHash(projectPath)
    }

    telemetry.codeTransform_jobStartedCompleteFromPopupDialog.emit({
        codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
        codeTransformJavaSourceVersionsAllowed: JDKToTelemetryValue(
            transformByQState.getSourceJDKVersion()!
        ) as CodeTransformJavaSourceVersionsAllowed,
        codeTransformJavaTargetVersionsAllowed: JDKToTelemetryValue(
            transformByQState.getTargetJDKVersion()
        ) as CodeTransformJavaTargetVersionsAllowed,
        codeTransformProjectId: projectId,
        result: MetadataResult.Pass,
    })

    await vscode.commands.executeCommand('workbench.view.extension.aws-codewhisperer-transformation-hub')
    await vscode.commands.executeCommand(
        'aws.amazonq.showPlanProgressInHub',
        codeTransformTelemetryState.getStartTime()
    )

    await vscode.commands.executeCommand('aws.amazonq.refresh')
}

export async function postTransformationJob() {
    transformByQState.getChatControllers()?.transformationFinished.fire({
        jobStatus: transformByQState.getPolledJobStatus(),
        tabID: ChatSessionManager.Instance.getSession().tabID,
    })
    const durationInMs = calculateTotalLatency(codeTransformTelemetryState.getStartTime())
    const resultStatusMessage = codeTransformTelemetryState.getResultStatus()

    const versionInfo = await getVersionData()
    const mavenVersionInfoMessage = `${versionInfo[0]} (${transformByQState.getMavenName()})`
    const javaVersionInfoMessage = `${versionInfo[1]} (${transformByQState.getMavenName()})`

    // Note: IntelliJ implementation of ResultStatusMessage includes additional metadata such as jobId.
    telemetry.codeTransform_totalRunTime.emit({
        codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
        codeTransformResultStatusMessage: resultStatusMessage,
        codeTransformRunTimeLatency: durationInMs,
        codeTransformLocalMavenVersion: mavenVersionInfoMessage,
        codeTransformLocalJavaVersion: javaVersionInfoMessage,
        result: resultStatusMessage === 'JobCompletedSuccessfully' ? MetadataResult.Pass : MetadataResult.Fail,
        reason: resultStatusMessage,
    })

    sessionJobHistory = processHistory(
        sessionJobHistory,
        convertDateToTimestamp(new Date(codeTransformTelemetryState.getStartTime())),
        transformByQState.getProjectName(),
        transformByQState.getStatus(),
        convertToTimeString(durationInMs),
        transformByQState.getJobId()
    )

    if (transformByQState.isSucceeded()) {
        void vscode.window.showInformationMessage(CodeWhispererConstants.transformByQCompletedMessage)
    } else if (transformByQState.isPartiallySucceeded()) {
        void vscode.window
            .showInformationMessage(
                CodeWhispererConstants.transformByQPartiallyCompletedMessage,
                CodeWhispererConstants.amazonQFeedbackText
            )
            .then(choice => {
                if (choice === CodeWhispererConstants.amazonQFeedbackText) {
                    void submitFeedback.execute(placeholder, CodeWhispererConstants.amazonQFeedbackKey)
                }
            })
    }

    if (transformByQState.getPayloadFilePath() !== '') {
        fs.rmSync(transformByQState.getPayloadFilePath(), { recursive: true, force: true }) // delete ZIP if it exists
    }
}

export async function transformationJobErrorHandler(error: any) {
    if (transformByQState.isCancelled()) {
        codeTransformTelemetryState.setResultStatus('JobCancelled')
        try {
            await stopJob(transformByQState.getJobId())
            void vscode.window
                .showErrorMessage(
                    CodeWhispererConstants.transformByQCancelledMessage,
                    CodeWhispererConstants.amazonQFeedbackText
                )
                .then(choice => {
                    if (choice === CodeWhispererConstants.amazonQFeedbackText) {
                        void submitFeedback.execute(placeholder, CodeWhispererConstants.amazonQFeedbackKey)
                    }
                })
        } catch {
            void vscode.window
                .showErrorMessage(
                    CodeWhispererConstants.errorStoppingJobMessage,
                    CodeWhispererConstants.amazonQFeedbackText
                )
                .then(choice => {
                    if (choice === CodeWhispererConstants.amazonQFeedbackText) {
                        void submitFeedback.execute(placeholder, CodeWhispererConstants.amazonQFeedbackKey)
                    }
                })
        }
    } else {
        transformByQState.setToFailed()
        codeTransformTelemetryState.setResultStatus('JobFailed')
        let displayedErrorMessage = `${
            CodeWhispererConstants.failedToCompleteJobMessage
        } ${transformByQState.getJobFailureErrorMessage()}`
        if (transformByQState.getJobFailureMetadata() !== '') {
            displayedErrorMessage += transformByQState.getJobFailureMetadata()
        }
        void vscode.window
            .showErrorMessage(displayedErrorMessage, CodeWhispererConstants.amazonQFeedbackText)
            .then(choice => {
                if (choice === CodeWhispererConstants.amazonQFeedbackText) {
                    void submitFeedback.execute(placeholder, CodeWhispererConstants.amazonQFeedbackKey)
                }
            })
    }
    if (sessionPlanProgress['startJob'] !== StepProgress.Succeeded) {
        sessionPlanProgress['startJob'] = StepProgress.Failed
    }
    if (sessionPlanProgress['buildCode'] !== StepProgress.Succeeded) {
        sessionPlanProgress['buildCode'] = StepProgress.Failed
    }
    if (sessionPlanProgress['generatePlan'] !== StepProgress.Succeeded) {
        sessionPlanProgress['generatePlan'] = StepProgress.Failed
    }
    if (sessionPlanProgress['transformCode'] !== StepProgress.Succeeded) {
        sessionPlanProgress['transformCode'] = StepProgress.Failed
    }
    getLogger().error(`CodeTransformation: ${error.message}`)
}

export async function cleanupTransformationJob(intervalId: NodeJS.Timeout | undefined) {
    clearInterval(intervalId)
    transformByQState.setJobDefaults()
    await vscode.commands.executeCommand('setContext', 'gumby.isStopButtonAvailable', false)
    await vscode.commands.executeCommand('aws.amazonq.refresh')
    void vscode.commands.executeCommand('aws.amazonq.showPlanProgressInHub', codeTransformTelemetryState.getStartTime())
}

export function processHistory(
    sessionJobHistory: { timestamp: string; module: string; status: string; duration: string; id: string }[],
    startTime: string,
    module: string,
    status: string,
    duration: string,
    id: string
) {
    sessionJobHistory = [] // reset job history; only storing the last run for now
    const copyState = { timestamp: startTime, module: module, status: status, duration: duration, id: id }
    sessionJobHistory.push(copyState)
    return sessionJobHistory
}

export function getJobHistory() {
    return sessionJobHistory
}

export function getPlanProgress() {
    return sessionPlanProgress
}

export async function stopTransformByQ(
    jobId: string,
    cancelSrc: CancelActionPositions = CancelActionPositions.BottomHubPanel
) {
    if (transformByQState.isRunning()) {
        getLogger().info('CodeTransformation: User requested to stop transformation. Stopping transformation.')
        transformByQState.setToCancelled()
        await vscode.commands.executeCommand('aws.amazonq.refresh')
        await vscode.commands.executeCommand('setContext', 'gumby.isStopButtonAvailable', false)
        try {
            await stopJob(jobId)
        } catch {
            void vscode.window.showErrorMessage(CodeWhispererConstants.errorStoppingJobMessage)
        }
        telemetry.codeTransform_jobIsCancelledByUser.emit({
            codeTransformCancelSrcComponents: cancelSrc as CodeTransformCancelSrcComponents,
            codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
            result: MetadataResult.Pass,
        })
    }
}

async function setContextVariables() {
    await vscode.commands.executeCommand('setContext', 'gumby.wasQCodeTransformationUsed', true)
    await vscode.commands.executeCommand('setContext', 'gumby.isStopButtonAvailable', true)
    await vscode.commands.executeCommand('setContext', 'gumby.isPlanAvailable', false)
    await vscode.commands.executeCommand('setContext', 'gumby.isSummaryAvailable', false)
    await vscode.commands.executeCommand('setContext', 'gumby.reviewState', TransformByQReviewStatus.NotStarted)
    await vscode.commands.executeCommand('setContext', 'gumby.transformationProposalReviewInProgress', false)
}
