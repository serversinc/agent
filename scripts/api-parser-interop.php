<?php

declare(strict_types=1);

use App\Services\Insights\ServerObservationParser;
use Illuminate\Contracts\Console\Kernel;

$project = $argv[1] ?? '';
$fixtures = $argv[2] ?? '';
if ($project === '' || $fixtures === '' || ! is_file($project.'/vendor/autoload.php')) {
    fwrite(STDERR, "Pass API_PROJECT_DIR and a fixture directory containing the Laravel checkout.\n");
    exit(2);
}

require $project.'/vendor/autoload.php';
$app = require $project.'/bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
$parser = new ServerObservationParser();
$failed = false;

foreach (glob(rtrim($fixtures, '/').'/*.json') as $path) {
    $name = basename($path);
    if ($name === 'manifest.json') {
        continue;
    }
    $example = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);
    $expected = $example['expected'];
    try {
        $actual = $parser->parse($example['body']);
        if (($expected['reject'] ?? false) === true) {
            throw new RuntimeException("Expected parser rejection for {$name}, but parse succeeded.");
        }
        if (array_key_exists('observation', $expected)) {
            if ($actual !== null) {
                throw new RuntimeException("Expected null observation for {$name}.");
            }
            continue;
        }
        if ($actual === null) {
            throw new RuntimeException("Expected parsed observation for {$name}.");
        }

        $actualFields = [
            'provenance' => $actual->provenance,
            'schema_version' => $actual->schemaVersion,
            'sample_id' => $actual->sampleId,
            'boot_id' => $actual->bootId,
            'observed_at' => $actual->observedAt?->toISOString(),
        ];
        if ($actualFields['observed_at'] !== null) {
            $actualFields['observed_at'] = preg_replace('/\.0+Z$/', 'Z', preg_replace('/(\.\d*?[1-9])0+Z$/', '$1Z', $actualFields['observed_at']));
        }
        foreach (['cpu', 'memory', 'network', 'disk'] as $collector) {
            $entry = $actual->collectors[$collector];
            $actualFields[$collector.'_status'] = $entry['status'];
            $actualFields[$collector.'_values'] = $entry['values'];
        }
        $cpu = $actual->collectors['cpu']['values'] ?? [];
        $memory = $actual->collectors['memory']['values'] ?? [];
        $network = $actual->collectors['network']['values'] ?? [];
        $disk = $actual->collectors['disk']['values'] ?? [];
        $actualFields += [
            'cpu_utilisation_pct' => $cpu['utilisation_pct'] ?? null,
            'cpu_estimate_pct' => $cpu['utilisation_estimate_pct'] ?? null,
            'cpu_utilisation_quality' => $cpu['utilisation_quality'] ?? null,
            'memory_used_bytes' => $memory['used_bytes'] ?? null,
            'network_duration' => $network['measured_duration_seconds'] ?? null,
            'disk_mount_count' => count($disk['mounts'] ?? []),
        ];
        foreach ($expected as $key => $value) {
            $actualValue = $actualFields[$key] ?? null;
            $matches = is_numeric($actualValue) && is_numeric($value)
                ? (float) $actualValue === (float) $value
                : $actualValue === $value;
            if (! array_key_exists($key, $actualFields) || ! $matches) {
                throw new RuntimeException("{$name}: {$key} expected ".var_export($value, true).', got '.var_export($actualFields[$key] ?? null, true));
            }
        }
    } catch (Throwable $exception) {
        if (($expected['reject'] ?? false) !== true || ! $exception instanceof InvalidArgumentException) {
            fwrite(STDERR, "FAIL {$name}: {$exception->getMessage()}\n");
            $failed = true;
        }
    }
    if (! $failed) {
        fwrite(STDOUT, "PASS {$name}\n");
    }
}

$producerJson = getenv('PRODUCER_OBSERVATION_JSON');
if ($producerJson !== false && $producerJson !== '') {
    try {
        $producer = json_decode($producerJson, true, flags: JSON_THROW_ON_ERROR);
        $parsed = $parser->parse(['observation' => $producer]);
        if ($parsed === null || $parsed->schemaVersion !== 1) {
            throw new RuntimeException('Producer observation did not parse as schema v1.');
        }
        foreach (['cpu', 'memory', 'network', 'disk'] as $collector) {
            if (($parsed->collectors[$collector]['status'] ?? null) === 'invalid') {
                throw new RuntimeException("Producer emitted an API-invalid {$collector} collector.");
            }
        }
        fwrite(STDOUT, "PASS actual agent producer observation\n");
    } catch (Throwable $exception) {
        fwrite(STDERR, "FAIL actual agent producer observation: {$exception->getMessage()}\n");
        $failed = true;
    }
}

$seriesJson = getenv('PRODUCER_OBSERVATIONS_JSON');
if ($seriesJson !== false && $seriesJson !== '') {
    try {
        $series = json_decode($seriesJson, true, flags: JSON_THROW_ON_ERROR);
        foreach ($series['observations'] ?? [] as $sample) {
            $parsed = $parser->parse(['observation' => $sample['observation'] ?? null]);
            if ($parsed === null || $parsed->schemaVersion !== 1) {
                throw new RuntimeException(($sample['name'] ?? 'producer sample').': parser returned no v1 observation');
            }
            foreach ($sample['expected']['collectors'] as $collector => $expectedCollector) {
                $actualCollector = $parsed->collectors[$collector] ?? null;
                if ($actualCollector === null || $actualCollector['status'] !== $expectedCollector['status'] || $actualCollector['values'] != $expectedCollector['values']) {
                    throw new RuntimeException(($sample['name'] ?? 'producer sample').": {$collector} expected ".json_encode($expectedCollector).', got '.json_encode($actualCollector));
                }
            }
            fwrite(STDOUT, 'PASS producer/'.($sample['name'] ?? 'unnamed')."\n");
        }
        $missingBoot = $series['missing_boot'] ?? null;
        if (! is_array($missingBoot) || $missingBoot['observation'] !== null || $missingBoot['expected'] !== null) {
            throw new RuntimeException('Missing-boot producer case did not fail closed to null.');
        }
        if ($parser->parse($missingBoot['observation']) !== null) {
            throw new RuntimeException('API parser did not preserve missing-boot null observation.');
        }
        fwrite(STDOUT, "PASS producer/missing-boot-id\n");
    } catch (Throwable $exception) {
        fwrite(STDERR, "FAIL deterministic producer series: {$exception->getMessage()}\n");
        $failed = true;
    }
}

exit($failed ? 1 : 0);
