import { mkdir, writeFile } from 'node:fs/promises';
import openapiTS, { astToString } from 'openapi-typescript';

const response = await fetch(process.env.API_SCHEMA_URL ?? 'http://localhost:8080/api/openapi');
if (!response.ok) throw new Error(`OpenAPI returned ${response.status}`);
const schema = await response.json();
schema.paths = Object.fromEntries(
  Object.entries(schema.paths).filter(([path]) => path.startsWith('/api/v1/')),
);
schema.servers = [{ url: '/', description: 'Same origin' }];
const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b, 'en'))
            .map(([key, item]) => [key, sorted(item)]),
        )
      : value;
const canonical = sorted(schema);
await mkdir('../contracts', { recursive: true });
await writeFile('../contracts/openapi.json', JSON.stringify(canonical, null, 2) + '\n');
await writeFile('src/api/generated.ts', astToString(await openapiTS(canonical, { alphabetize: true })));
console.log('Updated contracts/openapi.json and src/api/generated.ts');
