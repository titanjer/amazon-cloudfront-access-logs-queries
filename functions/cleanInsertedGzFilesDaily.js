const util = require('./util');

const aws = require('aws-sdk');
const s3 = new aws.S3();

// AWS Glue Data Catalog database and tables
const sourceTable = process.env.SOURCE_TABLE;
const targetTable = process.env.TARGET_TABLE;
const database = process.env.DATABASE;

function chunked(arr, n) {
  return arr.length ? [arr.slice(0, n), ...chunked(arr.slice(n), n)] : []
}

async function cleanInsertedGzFiles(database, sourceTable, targetTable, year, month, day) {

  const groupByGzFilesStatement = `
  -- Get Statistic of Gzip File on ${year}-${month}-${day}
  WITH gz AS (
    SELECT "$path" path, concat(year, '-', month, '-', day) dt, request_id
    FROM ${database}.${sourceTable}
    WHERE year = '${year}' AND month = '${month}' AND day = '${day}'
  ), parquet AS (
    SELECT concat(year, '-', month, '-', day) AS dt, request_id
    FROM ${database}.${targetTable}
    WHERE year = '${year}' AND month = '${month}' AND day = '${day}'
  ), join_gz_parquet AS (
    SELECT gz.path, gz.dt, gz.request_id g_id, parquet.request_id p_id
    FROM gz LEFT JOIN parquet
    ON gz.dt = parquet.dt AND gz.request_id = parquet.request_id
  )
  SELECT dt, path, COUNT(g_id) - COUNT(p_id) diff
  FROM join_gz_parquet
  GROUP BY 1, 2`;

  const s3Url = await util.runQuery(groupByGzFilesStatement);
  const rows = await util.downloadCSVQueryResults(s3Url);
  const readyToDelete = rows.filter(r => r.diff === '0');

  console.log('Total files:', rows.length, ', ready to delete files:', readyToDelete.length);
  if ( rows.length == 0 )
    return 0

  const buckets = [...new Set(rows.map(r => (new URL(r.path)).hostname))];
  if ( buckets.length != 1 )
    throw Error('Only clean same bucket data');

  const chunks = chunked(readyToDelete, 500);

  for ( var i = 0; i < chunks.length; i ++) {
    var chunk = chunks[i].map(r => ({Key: (new URL(r.path)).pathname.substr(1)}));
    var params = {
      Bucket: buckets[0],
      Delete: {
        Objects: chunk,
        Quiet: false
      }
    }
    let err, data = await s3.deleteObjects(params).promise();
    console.log(data.Deleted.length, 'deleted,', data.Errors.length, 'failed');

    if (data.Errors.length != 0)
      throw Error(`Delete s3 key failed, ${data.Errors.length} errors`)
  }
}

// get the partitions of yesterday or use `dt` in event
exports.handler = async (event, context, callback) => {
  if ( 'dt' in event ) {
    var yesterday = new Date(`${event.dt}T00:00:00Z`)
    if (isNaN(yesterday))
      throw new Error('invalid dt')
  } else {
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
  }

  const year = yesterday.getUTCFullYear();
  const month = (yesterday.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = yesterday.getUTCDate().toString().padStart(2, '0');

  console.log('Clean Inserted Gzip Files on ', { year, month, day });

  await cleanInsertedGzFiles(database, sourceTable, targetTable, year, month, day);
}
