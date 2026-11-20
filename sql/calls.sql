-- Trialing companies that have a CSM email and at least 15 inbound or 15 outbound calls.
-- Subquery aliases are required by BigQuery; they do not change the result.
-- This is a full snapshot. The job writes a HubSpot property only when the value changed.

WITH trialing_customers AS (
    SELECT DISTINCT company_id AS companyid
    FROM analytics_reporting.fact_user_master
    WHERE date_level = 'Day'
      AND date = CURRENT_DATE() - 1
      AND stripe_subscription_status = 'Trialing'
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
  AND companyid = 570491
ORDER BY companyid DESC
