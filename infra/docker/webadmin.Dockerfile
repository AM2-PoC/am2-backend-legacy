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

# The second layer of the auth guard, installed the way the real hosts install
# it: into PHP's own configuration rather than into a vhost.
#
# config.php carries the guard for every file that includes it, which is almost
# everything. This catches the file that includes nothing -- a library requested
# by URL, a debug script left in the document root. Without it, a local panel
# answers 200 for i18n.php and user_rules.php while production answers 401, and
# a development environment that is more permissive than production teaches the
# wrong thing. That is not hypothetical here: an auth mode set only in
# docker-compose.yml survived months after nothing read it, describing a
# behaviour the system had stopped having.
COPY infra/php/webadmin-prepend.php /etc/am2/php/webadmin-prepend.php
RUN printf '; AM2 panel guard, matching infra/scripts/install-webadmin-guard.sh\nauto_prepend_file = /etc/am2/php/webadmin-prepend.php\n' \
        > /usr/local/etc/php/conf.d/99-am2-webadmin-guard.ini

RUN chmod +x /usr/local/bin/webadmin-entrypoint.sh \
    && mkdir -p /var/www/html/update /tmp/am2-login-throttle \
    && chown -R www-data:www-data /var/www/html/update /tmp/am2-login-throttle

ENTRYPOINT ["/usr/local/bin/webadmin-entrypoint.sh"]
CMD ["apache2-foreground"]
