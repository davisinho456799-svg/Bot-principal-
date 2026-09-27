import pg from "pg";

const { Client } = pg;
const sourceUrl = process.env.NEON_DATABASE_URL;
const targetUrl = process.env.NEW_DATABASE_URL || process.env.DATABASE_URL;

if (!sourceUrl) {
  throw new Error("NEON_DATABASE_URL must be set for the one-time database copy.");
}

if (!targetUrl) {
  throw new Error("NEW_DATABASE_URL or DATABASE_URL must be set for the one-time database copy.");
}

if (sourceUrl === targetUrl) {
  throw new Error("The source and destination database URLs must be different.");
}

const source = new Client({ connectionString: sourceUrl });
const target = new Client({ connectionString: targetUrl });

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const qualifiedTable = (tableName) =>
  `${quoteIdentifier("public")}.${quoteIdentifier(tableName)}`;

async function getTables(client) {
  const result = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE '__drizzle%'
    ORDER BY table_name
  `);
  return result.rows.map((row) => row.table_name);
}

async function getColumns(client, tableName) {
  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName],
  );
  return result.rows.map((row) => row.column_name);
}

async function getCopyOrder(client, tables) {
  const tableSet = new Set(tables);
  const dependencies = new Map(tables.map((table) => [table, new Set()]));
  const result = await client.query(`
    SELECT
      tc.table_name AS table_name,
      ccu.table_name AS referenced_table_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
  `);

  for (const row of result.rows) {
    if (tableSet.has(row.table_name) && tableSet.has(row.referenced_table_name)) {
      dependencies.get(row.table_name).add(row.referenced_table_name);
    }
  }

  const order = [];
  const pending = new Set(tables);
  while (pending.size) {
    const ready = [...pending].filter((table) => {
      const tableDependencies = dependencies.get(table);
      return [...tableDependencies].every((dependency) => !pending.has(dependency));
    });

    if (!ready.length) {
      throw new Error("Could not determine a safe order for the source table dependencies.");
    }

    for (const table of ready.sort()) {
      order.push(table);
      pending.delete(table);
    }
  }

  return order;
}

async function copyTable(sourceClient, targetClient, tableName) {
  const sourceColumns = await getColumns(sourceClient, tableName);
  const targetColumns = await getColumns(targetClient, tableName);
  const targetColumnSet = new Set(targetColumns);
  const missingColumns = sourceColumns.filter((column) => !targetColumnSet.has(column));

  if (missingColumns.length) {
    throw new Error(
      `Target table ${tableName} is missing columns: ${missingColumns.join(", ")}`,
    );
  }

  if (!sourceColumns.length) return 0;

  const result = await sourceClient.query(
    `SELECT ${sourceColumns.map(quoteIdentifier).join(", ")} FROM ${qualifiedTable(tableName)}`,
  );
  const columnsSql = sourceColumns.map(quoteIdentifier).join(", ");
  const tableSql = qualifiedTable(tableName);
  const batchSize = 250;

  for (let offset = 0; offset < result.rows.length; offset += batchSize) {
    const batch = result.rows.slice(offset, offset + batchSize);
    const values = [];
    const placeholders = batch.map((row) => {
      const rowPlaceholders = sourceColumns.map((column) => {
        values.push(row[column] ?? null);
        return `$${values.length}`;
      });
      return `(${rowPlaceholders.join(", ")})`;
    });

    await targetClient.query(
      `INSERT INTO ${tableSql} (${columnsSql}) VALUES ${placeholders.join(", ")}`,
      values,
    );
  }

  return result.rows.length;
}

async function resetSequences(client, tables) {
  for (const tableName of tables) {
    const columns = await client.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_default LIKE 'nextval(%'
      `,
      [tableName],
    );

    for (const row of columns.rows) {
      const sequence = await client.query(
        "SELECT pg_get_serial_sequence($1, $2) AS sequence_name",
        [`public.${tableName}`, row.column_name],
      );
      const sequenceName = sequence.rows[0]?.sequence_name;
      if (!sequenceName) continue;

      await client.query(
        `
          SELECT setval(
            $1::regclass,
            COALESCE(MAX(${quoteIdentifier(row.column_name)}), 1),
            COUNT(*) > 0
          )
          FROM ${qualifiedTable(tableName)}
        `,
        [sequenceName],
      );
    }
  }
}

try {
  await source.connect();
  await target.connect();

  const sourceTables = await getTables(source);
  const targetTables = await getTables(target);
  const targetTableSet = new Set(targetTables);
  const missingTables = sourceTables.filter((table) => !targetTableSet.has(table));

  if (missingTables.length) {
    throw new Error(
      `Target database is missing tables: ${missingTables.join(", ")}. Run the schema push first.`,
    );
  }

  const nonEmptyTarget = [];
  for (const tableName of sourceTables) {
    const result = await target.query(
      `SELECT COUNT(*)::bigint AS count FROM ${qualifiedTable(tableName)}`,
    );
    if (Number(result.rows[0].count) > 0) {
      nonEmptyTarget.push(tableName);
    }
  }

  if (nonEmptyTarget.length) {
    throw new Error(
      `Target database is not empty. Refusing to copy over existing data in: ${nonEmptyTarget.join(", ")}`,
    );
  }

  const copyOrder = await getCopyOrder(source, sourceTables);
  await target.query("BEGIN");
  try {
    for (const tableName of copyOrder) {
      const count = await copyTable(source, target, tableName);
      console.log(`Copied ${count} rows from ${tableName}.`);
    }
    await resetSequences(target, copyOrder);
    await target.query("COMMIT");
  } catch (error) {
    await target.query("ROLLBACK");
    throw error;
  }

  console.log("Database copy completed successfully.");
} finally {
  await Promise.allSettled([source.end(), target.end()]);
}