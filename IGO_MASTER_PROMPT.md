# ROLE

You are GLM-5 running inside Claude CLI.

You are already inside my forked BentoPDF repository.

DO NOT explain how to fork or clone the repository.

DO NOT immediately start modifying files.

Your first responsibility is to inspect the existing repository and then produce a complete implementation plan in Markdown that can later be executed either by you or another AI agent (Mimo) if the context/token limit is reached.

The final deliverable of this task is NOT code.

The final deliverable is a very detailed implementation plan in Markdown.



==================================================
PROJECT VISION
==================================================

This project is NOT intended to remain BentoPDF.

Instead, BentoPDF should only become the PDF processing engine.

The final application must feel like a completely different product called:

igo

Users should not recognize BentoPDF anymore except where license attribution is legally required.

Think of BentoPDF as a reusable engine, not as the product itself.



==================================================
IMPORTANT
==================================================

Before making any assumptions:

Inspect the repository.

Never assume folder names.

Never assume framework structure.

Never assume routing.

Never assume UI components.

Verify everything.

Whenever uncertain, mark it as:

VERIFY



==================================================
REPOSITORY AUDIT
==================================================

First inspect:

- project structure
- package manager
- framework
- build system
- routing
- Docker files
- docker-compose
- nginx
- translations
- public assets
- branding system
- manifest
- service worker
- PDF engine structure
- PDF tools implementation
- Office conversion implementation
- OCR implementation
- localization
- environment variables
- build scripts

Inspect git state:

- current branch
- remote
- latest commit
- uncommitted files

Run a baseline build if possible.

Do not modify anything before documenting the repository.



==================================================
PROJECT GOAL
==================================================

Build an internal self-hosted web application named

igo

that provides PDF tools for internal company users.

The application should be modern, lightweight, simple, secure and maintainable.

The application is NOT public.

There is NO registration.

Only administrators can create users.



==================================================
DESIGN PHILOSOPHY
==================================================

DO NOT keep BentoPDF website.

DO NOT simply replace the logo.

Instead:

Create a completely new application.

Use BentoPDF only for PDF functionality.

Everything else should become igo.

The application should look like an internal enterprise tool instead of a public SaaS.



==================================================
UI REDESIGN
==================================================

Audit every page.

For each page decide:

KEEP

REDESIGN

DELETE

VERIFY

Produce a table.

Example:

| Page | Decision | Reason |

Landing
Delete
Marketing only

FAQ
Delete
Not needed

Pricing
Delete

Blog
Delete

GitHub
Delete

Documentation
Delete

Hero
Delete

Feature Showcase
Delete

Footer
Replace

Navbar
Replace

PDF Merge
Keep

PDF Split
Keep

OCR
Keep

Convert
Keep

Compress
Keep

Protect
Keep

Watermark
Keep

etc.



==================================================
APPLICATION PAGES
==================================================

The final application should only contain pages similar to:

Login

Home

About

Profile

Change Password

Admin Dashboard

User Management

Bulk Import Users

PDF Tools

404

Nothing else unless technically necessary.



==================================================
HOME PAGE
==================================================

Do NOT preserve BentoPDF landing page.

Instead build something minimal.

Example layout

--------------------------------------------------

igo

Privacy-first PDF Workspace

--------------------------------------------------

Grid of PDF tools

Merge

Split

Compress

OCR

Convert

Watermark

Protect

Unlock

Rotate

Repair

etc.

--------------------------------------------------

Recent activity (optional)

--------------------------------------------------

Footer

igo Internal Workspace

Version

--------------------------------------------------



==================================================
NAVBAR
==================================================

Replace BentoPDF navbar completely.

Left

igo logo

Home

About

Right

Dark / Light toggle

Language toggle

ID / EN

Hello, username

Authentication area

If guest

Login

If user

Profile

Logout

If admin

Admin

Profile

Logout

No BentoPDF navigation should remain.



==================================================
BRANDING
==================================================

Replace visible branding:

BentoPDF

Bentopdf

bentopdf

with

igo

where legally appropriate.

Keep license notices if required.

Keep third-party attribution if legally required.

Audit:

titles

meta

manifest

icons

favicons

footer

translations

SEO

OpenGraph

Twitter cards

README

docs

hardcoded strings

config

etc.



==================================================
LANGUAGE
==================================================

Default language

Bahasa Indonesia

Secondary language

English

Audit translation files.

Remove unnecessary public marketing translations if appropriate.



==================================================
DESIGN SYSTEM
==================================================

I already have a folder

stitch_bentopdf_bpdp_redesign

Inspect it.

Determine how it should be integrated.

Prefer reusing BentoPDF functionality while replacing visual components with this design system.



==================================================
AUTHENTICATION
==================================================

No registration.

Login only.

Username

Password

Captcha

Session timeout

2-3 hours

HttpOnly cookies

Secure cookies

SameSite protection

Logout

Persistent session after refresh.

Password hashing

Argon2id preferred.

Rate limiting.

Account lock recommendations.



==================================================
CAPTCHA
==================================================

Reference:

https://github.com/xsukax/xsukax-JS-CAPTCHA

Do not trust frontend-only validation.

Design backend verification.

Short lifetime.

One-time use.

Replay protection.

Rate limiting.

Explain architecture.



==================================================
RBAC
==================================================

Roles

admin

user

==================================================
ADMIN
==================================================

Dashboard

Manage users

CRUD users

Reset password

Change username

Deactivate user

Delete user

Bulk import CSV

Bulk import TXT

Preview import

Validate format

Hash imported passwords

Prevent deleting last admin

Search users

Pagination

Filters

==================================================
USER
==================================================

Home

PDF tools

Profile

Change password

Logout



==================================================
DATABASE
==================================================

Use PostgreSQL.

Design schema.

Users

Sessions

Roles

Login attempts

Captcha

Audit logs

Seeds

Dummy accounts

admin

user

Development only.

Document migrations.



==================================================
BACKEND
==================================================

Design backend architecture.

Suggested

Frontend

Backend API

PostgreSQL

Nginx

Docker Compose

Explain chosen architecture.

Explain auth flow.

Explain session flow.

Explain RBAC flow.



==================================================
PWA
==================================================

Audit existing implementation.

If missing

Implement

Manifest

Icons

Service Worker

Offline strategy

Installability

Theme colors

Maskable icons

BUT

Because login exists

Do not allow offline cache to bypass authentication.

Logout should invalidate cached authenticated pages where appropriate.

Document the tradeoffs between offline capability and authenticated access.

Preserve COOP/COEP and any headers required for SharedArrayBuffer and Office conversion.



==================================================
DOCKER
==================================================

One Docker Compose stack.

Frontend

Backend

PostgreSQL

Nginx

Volumes

Healthcheck

Restart policy

Environment variables

Development

Production

Document architecture.



==================================================
CI/CD
==================================================

Recommend best deployment.

Assume production runs on Proxmox.

Choose between

Ubuntu VM

Debian LXC

Explain why.

Recommend one.

Preferred recommendation:

Ubuntu Server VM + Docker Compose.

CI/CD

GitHub Actions

Build images

Push to registry

Server pulls images

docker compose up

Migration

Rollback

Healthcheck



==================================================
SECURITY
==================================================

Session security

CSRF

Rate limit

Headers

Password hashing

Secrets

Audit logs

CSV validation

SQL injection prevention

XSS

Dependency audit



==================================================
TESTING
==================================================

Authentication

RBAC

CSV import

Password change

PWA

Docker

PDF tools

OCR

Office conversion

Browser compatibility

Performance



==================================================
OUTPUT FORMAT
==================================================

Generate

IGO_IMPLEMENTATION_PLAN.md

The Markdown must include

1.
Executive Summary

2.
Repository Audit

3.
Architecture

4.
Current Repository Findings

5.
Pages Audit

6.
Components Audit

7.
Branding Audit

8.
Folder Structure Plan

9.
Database Schema

10.
API Design

11.
Implementation Phases

Each phase must include

Objective

Files

Tasks

Acceptance Criteria

Risks

Rollback

12.
Deployment Guide

13.
CI/CD Guide

14.
Environment Variables

15.
Security Checklist

16.
Testing Checklist

17.
License Compliance Checklist

18.
Future Improvements

19.
Continuation Notes For Mimo

This last section is extremely important.

It should contain everything another AI needs to continue work without losing context.

Include:

Completed phases

Pending phases

Modified files

Current git branch

Repository status

Known issues

Risks

Next exact task

Commands already executed

Important assumptions

Anything marked VERIFY



==================================================
IMPORTANT RULES
==================================================

Do not hallucinate.

Inspect first.

Never remove required license notices.

Prefer maintainability over shortcuts.

Use modern best practices.

The Markdown must be detailed enough that another AI can continue implementation with zero additional context.

Write explanations in Bahasa Indonesia.

Commands, filenames, APIs, database names, and code identifiers may remain in English.