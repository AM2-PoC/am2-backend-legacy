<?php
// offline-tests: exclude — runs after the pinned Laravel install in the toolchain job.

declare(strict_types=1);

use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;

require __DIR__ . '/../../laravel/vendor/autoload.php';

$app = require __DIR__ . '/../../laravel/bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$response = $kernel->handle(Request::create('/next', 'GET'));

if ($response->getStatusCode() !== 200) {
    fwrite(STDERR, "GET /next returned {$response->getStatusCode()}, expected 200\n");
    exit(1);
}

$kernel->terminate(Request::create('/next', 'GET'), $response);
