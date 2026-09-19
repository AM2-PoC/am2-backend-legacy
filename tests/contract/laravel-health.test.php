<?php
// offline-tests: exclude — runs after the pinned Laravel install in the toolchain job.

declare(strict_types=1);

use Illuminate\Http\Request;
use Illuminate\Contracts\Http\Kernel;

try {
    require __DIR__ . '/../../laravel/vendor/autoload.php';
    $app = require __DIR__ . '/../../laravel/bootstrap/app.php';
    $kernel = $app->make(Kernel::class);
    $request = static fn (string $path, string $method): Request => Request::create(
        $path,
        $method,
        server: ['HTTP_ACCEPT' => 'application/json'],
    );
    $response = $kernel->handle($request('/next/health', 'GET'));

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
    $candidate = $kernel->handle($request('/next/health', $method));
    if ($candidate->getStatusCode() !== 405) {
        fwrite(STDERR, "$method /next/health must return 405, got {$candidate->getStatusCode()}\n");
        exit(1);
    }
}

$options = $kernel->handle($request('/next/health', 'OPTIONS'));
$allowed = array_map('trim', explode(',', (string) $options->headers->get('Allow')));
sort($allowed);
if ($options->getStatusCode() !== 200 || $options->getContent() !== '' || $allowed !== ['GET', 'HEAD']) {
    fwrite(STDERR, "OPTIONS /next/health must return 200, no body, and Allow: GET, HEAD\n");
    exit(1);
}

$head = $kernel->handle($request('/next/health', 'HEAD'));
if ($head->getStatusCode() !== 200 || $head->getContent() !== '') {
    fwrite(STDERR, "HEAD /next/health must return 200 without a body\n");
    exit(1);
}

$missing = $kernel->handle($request('/next/missing', 'GET'));
if ($missing->getStatusCode() !== 404) {
    fwrite(STDERR, "expected unknown /next path status 404\n");
    exit(1);
}

fwrite(STDOUT, "Laravel health contract passed\n");
} catch (Throwable $error) {
    fwrite(STDERR, $error . "\n");
    exit(1);
}
