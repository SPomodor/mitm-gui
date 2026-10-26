"""Expose bounded pytest diagnostics as GitHub Actions check annotations."""
from pathlib import Path
import sys
import xml.etree.ElementTree as ET


def escape(value):
    return value.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')


report = Path(sys.argv[1])
if report.exists():
    for case in ET.parse(report).iter('testcase'):
        failure = case.find('failure')
        if failure is None:
            failure = case.find('error')
        if failure is not None:
            title = f"{case.get('classname', '')}.{case.get('name', '')}"
            detail = (failure.text or failure.get('message', 'Test failed'))[-12000:]
            print(f'::error title={escape(title)}::{escape(detail)}')
