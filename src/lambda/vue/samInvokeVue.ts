/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import Vue, { VNode } from 'vue'
import { VsCode } from '../../webviews/main'
import {
    MorePermissiveAwsSamDebuggerConfiguration,
    SamInvokerRequest,
    SamInvokerResponse,
    SamInvokeVueState,
} from './samInvoke'

declare const vscode: VsCode<SamInvokerRequest, SamInvokeVueState>

interface VueDataLaunchPropertyObject {
    value: string
    errorMsg: string
}
export interface SamInvokeVueData {
    msg: any
    showAllFields: boolean
    jsonError: string
    envVarsJsonError: string
    targetTypes: { [k: string]: string }[]
    runtimes: string[]
    httpMethods: string[]
    launchConfig: MorePermissiveAwsSamDebuggerConfiguration
    payload: VueDataLaunchPropertyObject
    environmentVariables: VueDataLaunchPropertyObject
    headers: VueDataLaunchPropertyObject
    stageVariables: VueDataLaunchPropertyObject
    // parameters: VueDataLaunchPropertyObject
}

function newLaunchConfig(target: 'template' | 'code' | 'api' = 'template'): MorePermissiveAwsSamDebuggerConfiguration {
    return {
        type: 'aws-sam',
        request: 'direct-invoke',
        name: '',
        aws: {
            credentials: '',
            region: '',
        },
        invokeTarget: {
            target,
            templatePath: '',
            logicalId: '',
            lambdaHandler: '',
            projectRoot: '',
        },
        lambda: {
            payload: {
                json: {},
                path: '',
            },
            environmentVariables: undefined,
            runtime: '',
            memoryMb: undefined,
            timeoutSec: undefined,
            // pathMappings: undefined
        },
        sam: {
            buildArguments: undefined,
            containerBuild: false,
            dockerNetwork: '',
            localArguments: undefined,
            skipNewImageCheck: false,
            template: {
                parameters: undefined
            }
        },
        api: {
            path: '',
            httpMethod: 'get',
            payload: {
                json: undefined,
                path: ''
            },
            headers: undefined,
            querystring: '',
            stageVariables: undefined,
            clientCertificateId: ''
        }
    }
}
export const Component = Vue.extend({
    created() {
        const oldState = vscode.getState()
        if (oldState) {
            this.launchConfig = oldState.launchConfig
            this.payload = oldState.payload
        }
        window.addEventListener('message', ev => {
            const event = ev.data as SamInvokerResponse
            switch (event.command) {
                case 'getSamplePayload':
                    this.payload.value = JSON.stringify(JSON.parse(event.data.payload), undefined, 4)
                    break
                case 'getTemplate':
                    this.launchConfig.invokeTarget.target = 'template'
                    this.launchConfig.invokeTarget.logicalId = event.data.logicalId
                    this.launchConfig.invokeTarget.templatePath = event.data.template
                    break
                case 'loadSamLaunchConfig':
                    this.launchConfig = event.data.launchConfig as MorePermissiveAwsSamDebuggerConfiguration
                    if (event.data.launchConfig.lambda?.payload) {
                        this.payload.value = JSON.stringify(event.data.launchConfig.lambda.payload.json, undefined, 4)
                    }
                    if (event.data.launchConfig.lambda?.environmentVariables) {
                        this.environmentVariables.value = JSON.stringify(event.data.launchConfig.lambda?.environmentVariables)
                    }
                    // if (event.data.launchConfig.sam?.template?.parameters) {
                    //     this.parameters = JSON.stringify(event.data.launchConfig.sam?.template?.parameters)
                    // }
                    if (event.data.launchConfig.api?.headers) {
                        this.headers.value = JSON.stringify(event.data.launchConfig.api?.headers)
                    }
                    if (event.data.launchConfig.api?.stageVariables) {
                        this.stageVariables.value = JSON.stringify(event.data.launchConfig.api?.stageVariables)
                    }
                    this.msg = `Loaded config ${event.data.launchConfig.name}`
                    break
            }
        })
    },
    data(): SamInvokeVueData {
        return {
            msg: 'Hello',
            showAllFields: false,
            jsonError: '',
            envVarsJsonError: '',
            targetTypes: [
                { name: 'Code', value: 'code' },
                { name: 'Template', value: 'template' },
                { name: 'API Gateway (Template)', value: 'api' },
            ],
            runtimes: [
                'nodejs10.x',
                'nodejs12.x',
                'nodejs14.x',
                'python2.7',
                'python3.6',
                'python3.7',
                'python3.8',
                'dotnetcore2.1',
                'dotnetcore3.1',
            ],
            httpMethods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'],
            launchConfig: newLaunchConfig(),
            payload: {value: '', errorMsg: ''},
            environmentVariables: {value: '', errorMsg: ''},
            // parameters: {value: '', errorMsg: ''},
            headers: {value: '', errorMsg: ''},
            stageVariables: {value: '', errorMsg: ''}
        }
    },
    watch: {
        launchConfig: {
            handler(newval: MorePermissiveAwsSamDebuggerConfiguration) {
                vscode.setState({
                    payload: this.payload,
                    launchConfig: newval,
                })
            },
            deep: true,
        },
        payload: function (newval: {value: string, errorMsg: string}) {
            this.resetJsonErrors()
            vscode.setState({
                payload: newval,
                launchConfig: this.launchConfig,
            })
        },
    },
    methods: {
        resetJsonErrors() {
            this.payload.errorMsg = ''
            this.environmentVariables.errorMsg = ''
            this.headers.errorMsg = ''
            this.stageVariables.errorMsg = ''
        },
        launch() {
            this.formatDataAndExecute('invokeLaunchConfig')
        },
        save() {
            this.formatDataAndExecute('saveLaunchConfig')
        },
        loadConfig() {
            this.resetJsonErrors()
            vscode.postMessage({
                command: 'loadSamLaunchConfig',
            })
        },
        loadPayload() {
            this.resetJsonErrors()
            vscode.postMessage({
                command: 'getSamplePayload',
            })
        },
        loadResource() {
            this.resetJsonErrors()
            vscode.postMessage({
                command: 'getTemplate',
            })
        },
        toggleShowAllFields() {
            this.showAllFields = !this.showAllFields
        },
        formatFieldToStringArray(field: string | undefined) {
            if(!field){
                return undefined
            }
            //Reg ex for a comma with 0 or more whitespace before and/or after
            const re = /\s*,\s*/g
            return field.trim().split(re)
        },
        formatStringtoJSON(field: VueDataLaunchPropertyObject) {
            field.errorMsg = ''
            if (field.value !== '') {
                try {
                    return JSON.parse(this.payload.value)
                } catch (e) {
                    field.errorMsg = e
                    throw e
                }
            } 
        },
        formatDataAndExecute(command: 'saveLaunchConfig' | 'invokeLaunchConfig') {
            this.resetJsonErrors()

            let payloadJson, environmentVariablesJson, headersJson, stageVariablesJson 

            try {
            payloadJson = this.formatStringtoJSON(this.payload)
            environmentVariablesJson = this.formatStringtoJSON(this.environmentVariables)
            headersJson = this.formatStringtoJSON(this.headers)
            stageVariablesJson = this.formatStringtoJSON(this.stageVariables)
            } catch {
                return
            }  

            vscode.postMessage({
                command: command,
                data: {
                    launchConfig: {
                        ...this.launchConfig,
                        lambda: {
                            ...this.launchConfig.lambda,
                            payload: {
                                ...this.launchConfig.payload,
                                json: payloadJson,
                            },
                            environmentVariables: environmentVariablesJson
                        },
                        sam: {
                            ...this.launchConfig.sam,
                            buildArguments: this.formatFieldToStringArray(this.launchConfig.sam?.buildArguments?.toString()),
                            localArguments: this.formatFieldToStringArray(this.launchConfig.sam?.localArguments?.toString())
                        },
                        api: this.launchConfig.api ?  {
                            ...this.launchConfig.api,
                            headers: headersJson,
                            stageVariables: stageVariablesJson,
                        } : undefined
                    },
                },
            })
        }
    },
    // `createElement` is inferred, but `render` needs return type
    template: `<!--
    * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
    * SPDX-License-Identifier: Apache-2.0
    -->

<!--This is an experimental template that is not used directly.  -->

<template>
    <form class="invoke-lambda-form">
        <h1>SAM Debug Configuration Editor</h1>
        <button v-on:click.prevent="loadConfig">Load Existing Debug Configuration</button><br />
        <div class="config-details">
            <div class="section-header">
                <h2>Configuration Details</h2>
            </div>
            <label for="target-type-selector">Invoke Target Type</label>
            <select name="target-types" id="target-type-selector" v-model="launchConfig.invokeTarget.target">
                <option v-bind:value="type.value" v-for="(type, index) in targetTypes" :key="index">{{ type.name }}</option>
            </select><span class="data-view">{{launchConfig.invokeTarget.target}}</span>
            <div class="target-code" v-if="launchConfig.invokeTarget.target === 'code'">
                <div class="config-item">
                    <label for="select-directory">Project Root</label>
                    <input
                        id="select-directory"
                        v-model="launchConfig.invokeTarget.projectRoot"
                        placeholder="Enter a directory"
                    />
                    <span class="data-view">the selected directory: {{ launchConfig.invokeTarget.projectRoot }}</span>
                </div>
                <div class="config-item">
                    <label for="lambda-handler">Lambda Handler</label>
                    <input
                        type="text"
                        placeholder="Enter the lambda handler"
                        name="lambda-handler"
                        id="lambda-handler"
                        v-model="launchConfig.invokeTarget.lambdaHandler"
                    />
                    <span class="data-view">lamda handler :{{ launchConfig.invokeTarget.lambdaHandler }}</span>
                </div>
                <div class="config-item">
                    <label for="runtime-selector">Runtime</label>
                    <select name="runtimeType" v-model="launchConfig.lambda.runtime">
                        <option disabled>Choose a runtime...</option>
                        <option v-for="(runtime, index) in runtimes" v-bind:value="runtime" :key="index">
                            {{ runtime }}
                        </option>
                    </select>
                    <span class="data-view">runtime in data: {{ launchConfig.lambda.runtime }}</span>
                </div>
            </div>
            <div class="target-template" v-else-if="launchConfig.invokeTarget.target === 'template'">
                <button v-on:click.prevent="loadResource">Load Resource</button><br />
                <div class="config-item">
                    <label for="template-path">Template Path</label>
                    <input
                        id="template-path-button"
                        v-model="launchConfig.invokeTarget.templatePath"
                        placeholder="Enter the template path..."
                    /><span class="data-view"
                        >Template path from data: {{ launchConfig.invokeTarget.templatePath }}</span
                    >
                </div>
                <div class="config-item">
                    <label for="logicalID">Resource (Logical Id)</label>
                    <input
                        name="template-logical-id"
                        id="template-logical-id"
                        placeholder="Enter a resource"
                        v-model="launchConfig.invokeTarget.logicalId"
                    /><span class="data-view"> Logical Id from data: {{ launchConfig.invokeTarget.logicalId }}</span>
                </div>
            </div>
            <div class="target-apigw" v-else-if="launchConfig.invokeTarget.target === 'api'">
                <button v-on:click.prevent="loadResource">Load Resource</button><br />
                <div class="config-item">
                    <label for="template-path">Template Path</label>
                    <input
                        id="template-path-button"
                        v-model="launchConfig.invokeTarget.templatePath"
                        placeholder="Enter the template path..."
                    /><span class="data-view"
                        >Template path from data: {{ launchConfig.invokeTarget.templatePath }}</span
                    >
                </div>
                <div class="config-item">
                    <label for="logicalID">Resource (Logical Id)</label>
                    <input
                        name="template-logical-id"
                        id="template-logical-id"
                        placeholder="Enter a resource"
                        v-model="launchConfig.invokeTarget.logicalId"
                    />
                </div>
                <div class="config-item">
                    <label for="path">Path</label>
                    <input type="text" v-model="launchConfig.api.path" >
                </div>
                <div class="config-item">
                    <label for="http-method-selector">HTTP Method</label>
                    <select name="http-method"  v-model="launchConfig.api.httpMethod">
                        <option v-for="(method, index) in httpMethods" v-bind:value="method.toLowerCase()" :key="index">
                            {{ method }}
                        </option>
                    </select><span class="data-view">{{launchConfig.api.httpMethod}}</span>
                </div>
                <div class="config-item">
                    <label for="query-string">Query String</label>
                    <input name="query-string" id="query-string" cols="15" rows="2" placeholder="Enter a query" />
                </div>
                <div class="config-item">
                    <label for="headers">Headers</label>
                    <input type="text" v-model="headers.value" placeholder="Enter as valid JSON" >
                    <div class="json-parse-error" v-if="headers.errorMsg">Error parsing JSON: {{headers.errorMsg}}</div>
                </div>
            </div>
            <div v-else>Select an Invoke Target</div>
            <button @click="toggleShowAllFields">{{showAllFields ? "Show Less Fields" : "Show All Fields"}}</button>
            <div v-if="showAllFields">
                <h3>aws</h3>
                <div class="config-item">
                    <label for="awsConnection">Credentials:</label>
                    <input type="text" v-model="launchConfig.aws.credentials" >
                </div>
                <div class="config-item">
                    <label for="region">Region</label>
                    <input type="text" v-model="launchConfig.aws.region" >
                </div>
                <h3>lambda</h3>
                <div class="config-item">
                    <label for="">Environment Variables</label>
                    <input type="text" placeholder="Enter as valid JSON" v-model="environmentVariables.value">
                    <div class="json-parse-error" v-if="environmentVariables.errorMsg">Error parsing JSON: {{environmentVariables.errorMsg}}</div>
                </div>
                <div class="config-item">
                    <label for="memory">Memory (MB)</label>
                    <input type="number" v-model="launchConfig.lambda.memoryMb" >
                </div>
                <div class="config-item">
                    <label for="timeoutSec">Timeout (s)</label>
                    <input type="number" v-model="launchConfig.lambda.timeoutSec" >
                </div>
                <!-- <div class="config-item">
                    <label for="pathMappings">Path Mappings</label>
                    <input type="text" v-model="launchConfig.lambda.pathMappings" >
                </div> -->
                <h3>sam</h3>
                <div class="config-item">
                    <label for="buildArguments">Build Arguments</label>
                    <input type="text" v-model="launchConfig.sam.buildArguments" >
                </div>
                <div class="config-item">
                    <label for="containerBuild">Container Build</label>
                    <select name="containerBuild" id="containerBuild" v-model="launchConfig.sam.containerBuild">
                        <option v-bind:value=false :key="0">False</option>
                        <option v-bind:value=true :key="1">True</option>
                    </select>
                </div>
                <div class="config-item">
                    <label for="dockerNetwork">Docker Network</label>
                    <input type="text" v-model="launchConfig.sam.dockerNetwork">
                </div>
                <div class="config-item">
                    <label for="localArguments">Local Arguments</label>
                    <input type="text" v-model="launchConfig.sam.localArguments" >
                </div>
                <div class="config-item">
                    <label for="skipNewImageCheck">Skip New Image Check</label>
                    <select name="skipNewImageCheck" id="skipNewImageCheck" v-model="launchConfig.sam.skipNewImageCheck">
                        <option value=false :key="0">False</option>
                        <option value=true :key="1">True</option>
                    </select>
                </div>
                <!-- <div class="config-item">
                    <label for="templateParameters">Template - Parameters</label>
                    <input type="text" v-model="launchConfig.sam.template.parameters" >
                </div> -->
                <h3>api</h3>
                <div class="config-item">
                    <label for="querystring">Query String</label>
                    <input type="text" v-model="launchConfig.api.querystring" >
                </div>
                <div class="config-item">
                    <label for="stageVariables">Stage Variables</label>
                    <input type="text" v-model="stageVariables.value" placeholder="Enter as valid JSON">
                    <div class="json-parse-error" v-if="stageVariables.errorMsg">Error parsing JSON: {{stageVariables.errorMsg}}</div>
                </div>
                <div class="config-item">
                    <label for="clientCerificateId">Client Certificate ID</label>
                    <input type="text" v-model="launchConfig.api.clientCerificateId" >
                </div>
            </div>
        </div>
        <div class="payload-section">
            <div class="section-header">
                <h2>Payload</h2>
            </div>
            <button v-on:click.prevent="loadPayload">Load Sample Payload</button><br />
            <textarea name="lambda-payload" id="lambda-payload" cols="60" rows="5" v-model="payload.value"></textarea>
            <span class="data-view">payload from data: {{ payload }} </span>
            <div class="json-parse-error" v-if="payload.errorMsg">Error parsing JSON: {{payload.errorMsg}}</div>
        </div>
        <div class="invoke-button-container">
            <button v-on:click.prevent="save">Save Debug Configuration</button>
            <button id="invoke-button" v-on:click.prevent="launch">Invoke Debug Configuration</button>
        </div>
    </form>
</template>

`
,
})

new Vue({
    el: '#vueApp',
    render: (createElement): VNode => {
        return createElement(Component)
    },
})
