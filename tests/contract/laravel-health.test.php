<?php
// offline-tests: exclude — runs after the pinned Laravel install in the toolchain job.

declare(strict_types=1);

use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;

require __DIR__ . '/../../laravel/vendor/autoload.php';

$app = require __DIR__ . '/../../laravel/bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$response = $kernel->handle(Request::create('/next/health', 'GET'));

if ($response->getStatusCode() !== 200) {
    fwrite(STDERR, "expected GET /next/health status 200, got {$response->getStatusCode()}\n");
    exit(1);
}

if ($response->headers->get('Content-Type') !== 'application/json') {
    fwrite(STDERR, "expected application/json Content-Type\n");
    exit(1);
}

if ($response->getContent() !== '{"status":"ok"}') {
    fwrite(STDERR, "unexpected health body: {$response->getContent()}\n");
    exit(1);
}

foreach (['POST', 'PUT', 'PATCH', 'DELETE'] as $method) {
    $candidate = $kernel->handle(Request::create('/next/health', $method));
    if ($candidate->getStatusCode() < 400) {
        fwrite(STDERR, "$method /next/health must not succeed\n");
        exit(1);
    }
    $kernel->terminate(Request::create('/next/health', $method), $candidate);
}

$missing = $kernel->handle(Request::create('/next/missing', 'GET'));
if ($missing->getStatusCode() !== 404) {
    fwrite(STDERR, "expected unknown /next path status 404\n");
    exit(1);
}

$kernel->terminate(Request::create('/next/health', 'GET'), $response);
fwrite(STDOUT, "Laravel health contract passed\n");
