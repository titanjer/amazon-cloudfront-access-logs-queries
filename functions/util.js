// Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const aws = require('aws-sdk');
const athena = new aws.Athena({ apiVersion: '2017-05-181' });
const s3 = new aws.S3({ apiVersion: '2006-03-01'});

// s3 URL of the query results (without trailing slash)
const athenaQueryResultsLocation = process.env.ATHENA_QUERY_RESULTS_LOCATION;
const athenaWorkGroupName = process.env.ATHENA_WORK_GROUP_NAME;

async function waitForQueryExecution(queryExecutionId) {
    while (true) {
        var data = await athena.getQueryExecution({
            QueryExecutionId: queryExecutionId
        }).promise();
        const state = data.QueryExecution.Status.State;
        if (state === 'SUCCEEDED') {
            return data.QueryExecution.ResultConfiguration.OutputLocation;
        } else if (state === 'FAILED' || state === 'CANCELLED') {
            throw Error(`Query ${queryExecutionId} failed: ${data.QueryExecution.Status.StateChangeReason}`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

exports.runQuery = async (query) => {
    var params = {
        QueryString: query,
        ResultConfiguration: {
            OutputLocation: athenaQueryResultsLocation
        },
        WorkGroup: athenaWorkGroupName
    };
    var data = await athena.startQueryExecution(params).promise()
    return await waitForQueryExecution(data.QueryExecutionId);
}

function unquote(str) {
    return str.replace(/(^")|("$)/g, '')
}

exports.downloadCSVQueryResults = async (s3Url) => {
    const csvUrl = new URL(s3Url);

    const getParams = {
        Bucket: csvUrl.hostname,
        Key: csvUrl.pathname.substr(1),
    };
    const response = await s3.getObject(getParams).promise();
    const content = response.Body.toString();
    const lines = content.split('\n');
    const headers = lines[0].split(',').map(unquote);

    var rows = [];
    for ( var i = 1; i < lines.length; i ++) {
        var items = lines[i].split(',');
        if ( items.length != headers.length )
            continue;

        var row = {};
        items.forEach((v, i) => row[headers[i]] = unquote(v));
        rows.push(row);
    }
    return rows
}