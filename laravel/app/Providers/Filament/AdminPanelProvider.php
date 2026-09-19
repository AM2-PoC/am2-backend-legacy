<?php

declare(strict_types=1);

namespace App\Providers\Filament;

use Filament\Pages\Dashboard;
use Filament\Panel;
use Filament\PanelProvider;

final class AdminPanelProvider extends PanelProvider
{
    public function panel(Panel $panel): Panel
    {
        return $panel
            ->id('admin')
            ->path('next')
            ->pages([Dashboard::class])
            ->widgets([]);
    }
}