# The panel, for a laptop.
#
# Matches staging's PHP 8.3 and the extensions config.php and settings.php
# actually use: pdo_pgsql for the database, zip for the export handlers. This
# is a development image -- see infra/apache/*.conf for the real vhosts.
FROM php:8.3-apache

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq-dev libzip-dev \
    && docker-php-ext-install pdo_pgsql pgsql zip \
    && a2enmod rewrite \
    && rm -rf /var/lib/apt/lists/*

COPY infra/docker/apache-webadmin.conf /etc/apache2/sites-available/000-default.conf
COPY infra/docker/webadmin-entrypoint.sh /usr/local/bin/webadmin-entrypoint.sh

RUN chmod +x /usr/local/bin/webadmin-entrypoint.sh \
    && mkdir -p /var/www/html/update /tmp/am2-login-throttle \
    && chown -R www-data:www-data /var/www/html/update /tmp/am2-login-throttle

ENTRYPOINT ["/usr/local/bin/webadmin-entrypoint.sh"]
CMD ["apache2-foreground"]
