-- Trialing companies that have a CSM email and at least 15 inbound or 15 outbound calls.
-- Subquery aliases are required by BigQuery; they do not change the result.
-- This is a full snapshot. The job writes a HubSpot property only when the value changed.

WITH trialing_customers AS (
    SELECT * FROM (
        SELECT companyid, account_status, source_timestamp FROM (
            SELECT
                companyid,
                account_status,
                TIMESTAMP_MILLIS(datastream_metadata.source_timestamp) AS source_timestamp
            FROM jclive.users
        ) AS user_snapshots
        WHERE account_status IS NOT NULL
        QUALIFY ROW_NUMBER() OVER (PARTITION BY companyid ORDER BY source_timestamp DESC) = 1
    ) AS latest_status
    WHERE account_status = 'TRIALING'
),

csm_emails AS (
    SELECT
        companyid,
        email
    FROM hubspot_migration.jc_hs_csm
),

call_counts AS (
    SELECT * FROM (
        SELECT DISTINCT
            companyId AS company_id,
            COUNT(CASE WHEN direction = 1 THEN entityId ELSE NULL END) AS IB_Calls,
            COUNT(CASE WHEN direction = 0 THEN entityId ELSE NULL END) AS OB_Calls
        FROM datastreamsyncedtables.balance_call_logs
        GROUP BY 1
    ) AS counts
    WHERE IB_Calls >= 15 OR OB_Calls >= 15
)

SELECT
    *,
    CASE WHEN IB_Calls >= 15 THEN TRUE ELSE FALSE END AS IBC_flag,
    CASE WHEN OB_Calls >= 15 THEN TRUE ELSE FALSE END AS OBC_flag
FROM (
    SELECT
        t.companyid,
        t.account_status,
        t.source_timestamp,
        e.email,
        c.IB_Calls,
        c.OB_Calls
    FROM trialing_customers t
    LEFT JOIN csm_emails e
        ON CAST(t.companyid AS STRING) = CAST(e.companyid AS STRING)
    LEFT JOIN call_counts c
        ON CAST(t.companyid AS STRING) = CAST(c.company_id AS STRING)
) AS joined
WHERE email IS NOT NULL
  AND (IB_Calls IS NOT NULL OR OB_Calls IS NOT NULL)
ORDER BY companyid DESC
