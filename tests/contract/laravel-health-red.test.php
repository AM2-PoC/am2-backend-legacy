<?php
// offline-tests: exclude — runs after the pinned Laravel install in the toolchain job.

declare(strict_types=1);

use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;

require __DIR__ . '/../../laravel/vendor/autoload.php';

$app = require __DIR__ . '/../../laravel/bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$request = Request::create('/next/health', 'GET');
$response = $kernel->handle($request);

if ($response->getStatusCode() !== 404) {
    fwrite(STDERR, "expected P2A-04 RED status 404, got {$response->getStatusCode()}\n");
    exit(1);
}

$kernel->terminate($request, $response);
fwrite(STDOUT, "P2A-04 behavioral RED: Laravel boots and /next/health is 404\n");