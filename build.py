import zipfile
with zipfile.ZipFile('manuscript-grid.xpi', 'w', zipfile.ZIP_DEFLATED) as z:
    for f in ('manifest.json', 'bootstrap.js'):
        z.write(f)
print('built manuscript-grid.xpi')
